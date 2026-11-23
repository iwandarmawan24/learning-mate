// Ingests the handbook from its markdown chapter files (H1=chapter, H2=section).
// Citation granularity is [hb.<ch>.<sec>] (H2), matching spec section 2.1 --
// but each H2 section is stored as one chunk ROW PER H3 SUBSECTION, not one
// giant blob. H2 sections vary 1,200-11,000 chars; BM25's length normalization
// buries long multi-topic sections behind short unrelated ones (graduation
// check caught this: "channel ecosystem funnel" ranked hb.11.7 over hb.1.3).
// H3-sized chunks keep retrieval units roughly uniform; citation still
// resolves to the parent H2 node, so [hb.1.3] stays correct either way.
// No LLM concept/prereq extraction here; add kind='concept' nodes by hand.
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

interface ParsedSection {
  heading: string;
  ordinal: number;
  text: string;
}

interface ParsedChunk {
  ordinal: number;
  heading: string;
  text: string;
}

export function parseMarkdownChapters(
  db: Database.Database,
  chaptersDir: string,
  bookCode: string,
  bookTitle: string
) {
  const files = fs
    .readdirSync(chaptersDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const insertSource = db.prepare(
    `INSERT INTO sources (kind, tier, title, uri, fetched_at) VALUES ('material','T3',?,?,datetime('now'))`
  );
  const sourceId = insertSource.run(bookTitle, chaptersDir).lastInsertRowid as number;

  const insertNode = db.prepare(
    `INSERT INTO curriculum_nodes (parent_id, kind, code, title, ordinal) VALUES (?,?,?,?,?)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (source_id, curriculum_node_id, ordinal, heading, text) VALUES (?,?,?,?,?)`
  );

  const bookNodeId = insertNode.run(null, "book", bookCode, bookTitle, 0).lastInsertRowid as number;

  let chaptersIngested = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(chaptersDir, file), "utf-8");
    const lines = raw.split("\n");

    const h1Line = lines.find((l) => /^#\s+/.test(l));
    if (!h1Line) continue; // skip files with no chapter title (e.g. stray notes)

    const chapterMatch = h1Line.match(/^#\s+Chapter\s+(\d+)\s*:?\s*(.*)$/i);
    const chapterNum = chapterMatch ? Number(chapterMatch[1]) : chaptersIngested + 1;
    const chapterTitle = chapterMatch ? chapterMatch[2].trim() : h1Line.replace(/^#\s+/, "").trim();

    const chapterCode = `${bookCode}.${chapterNum}`;
    const chapterId = insertNode.run(bookNodeId, "chapter", chapterCode, chapterTitle, chapterNum)
      .lastInsertRowid as number;

    const sections = splitIntoH2Sections(lines);
    for (const section of sections) {
      const sectionCode = `${bookCode}.${chapterNum}.${section.ordinal}`;
      const sectionId = insertNode
        .run(chapterId, "section", sectionCode, section.heading, section.ordinal)
        .lastInsertRowid as number;

      const subChunks = splitIntoH3Chunks(section.text, section.heading);
      for (const chunk of subChunks) {
        insertChunk.run(sourceId, sectionId, chunk.ordinal, chunk.heading, chunk.text.trim());
      }
    }

    chaptersIngested++;
  }

  return { sourceId, bookNodeId, chapters: chaptersIngested };
}

function splitIntoH2Sections(lines: string[]): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let ordinal = 0;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(?:\d+\.\s*)?(.+)$/);
    const isH1 = /^#\s+/.test(line) && !/^##/.test(line);
    if (h2 && !isH1) {
      if (current) sections.push(current);
      ordinal++;
      current = { heading: h2[1].trim(), ordinal, text: "" };
    } else if (current) {
      current.text += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

// Splits one H2 section's text into H3-sized chunks, carrying the H3 heading
// text separately (stripped of leading numbering) so retrieve() can weight
// it. Falls back to the whole section (heading = the H2 title) when there
// are no H3 headings (short sections like Case Studies, Exercises).
function splitIntoH3Chunks(sectionText: string, sectionHeading: string): ParsedChunk[] {
  const lines = sectionText.split("\n");
  const chunks: ParsedChunk[] = [];
  let current = "";
  let currentHeading = "";
  let ordinal = 0;
  let sawH3 = false;

  const flush = () => {
    if (current.trim()) chunks.push({ ordinal: ordinal++, heading: currentHeading, text: current });
  };

  for (const line of lines) {
    const h3 = line.match(/^###\s+(?:[\d.]+\s*)?(.+)$/);
    if (h3) {
      sawH3 = true;
      flush();
      currentHeading = h3[1].trim();
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  flush();

  if (!sawH3) {
    return [{ ordinal: 0, heading: sectionHeading, text: sectionText }];
  }
  return chunks;
}

// Seeds the two known handbook errors from Appendix B as open claim_conflicts,
// per spec section 2.1 -- day-one, not discovered later.
export function seedKnownConflicts(db: Database.Database, bookCode: string) {
  const findNode = db.prepare(`SELECT id FROM curriculum_nodes WHERE code = ?`);

  const conflicts: { code: string; claimA: string; claimB: string; note: string }[] = [
    {
      code: `${bookCode}.13`,
      claimA:
        `Handbook §7 lists "click-to-cancel-class rules" among regulatory forces currently making dark patterns a legal liability, implying the FTC rule is in force.`,
      claimB:
        `FTC's Click-to-Cancel Rule (16 CFR Part 425) was vacated in full by the 8th Circuit on 8 July 2025 (Custom Communications, Inc. v. FTC) on procedural grounds. Never took effect. FTC opened a revival ANPRM in March 2026, not yet final. ROSCA remains the operative enforcement tool.`,
      note: `Direction of travel (enforcement risk) is real; the specific instrument is not in force. Don't cite the rule as active law.`,
    },
    {
      code: `${bookCode}.2`,
      claimA:
        `Handbook treats third-party cookie deprecation in Chrome as the settled trajectory ("privacy correction" narrative), implying an imminent Chrome cookie shutoff.`,
      claimB:
        `Google confirmed 22 April 2025 it is NOT force-deprecating third-party cookies in Chrome -- they remain available by default, no new consent prompt, Privacy Sandbox wound down Oct 2025. Only ever shipped 1% Stable-channel restriction (Jan 2024).`,
      note: `Mechanism claim (Chrome shutoff) is wrong; consequence claim (move to first-party data / identity spine) still holds because Safari ITP / Firefox ETP already block third-party cookies by default. Identity diversification is a hedge, not an emergency. Same conflict applies to hb.4 (Measurement Foundations).`,
    },
    {
      code: `${bookCode}.4`,
      claimA:
        `Handbook's measurement-architecture chapter motivates first-party/server-side tracking partly via an imminent Chrome third-party cookie shutoff.`,
      claimB:
        `Same correction as hb.2: Chrome is not force-deprecating third-party cookies (confirmed 22 April 2025). The architecture advice holds, but not for that reason.`,
      note: `See hb.2 conflict for full sourcing. Duplicated here because the chapter's own measurement-stack argument leans on the (wrong) deprecation premise.`,
    },
  ];

  const insert = db.prepare(
    `INSERT INTO claim_conflicts (node_id, claim_a, claim_b, note, status) VALUES (?,?,?,?,'open')`
  );

  let seeded = 0;
  for (const c of conflicts) {
    const node = findNode.get(c.code) as { id: number } | undefined;
    insert.run(node?.id ?? null, c.claimA, c.claimB, c.note);
    seeded++;
  }
  return seeded;
}
