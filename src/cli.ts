#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "./db/schema.js";
import { parsePdf } from "./ingest/parsePdf.js";
import { parseMarkdownChapters, seedKnownConflicts } from "./ingest/parseMarkdown.js";
import { retrieve } from "./retrieve.js";
import { applyEvidence, getConceptState, type EvidenceKind, type RubricScore } from "./learner/rules.js";

const program = new Command();
program.name("harness").description("Learning harness CLI (S0+S1)");

program
  .command("ingest-pdf")
  .argument("<pdf>", "path to handbook PDF (must have outline/bookmarks)")
  .option("--code <code>", "book code, e.g. hb", "hb")
  .option("--title <title>", "book title", "Handbook")
  .action(async (pdf: string, opts: { code: string; title: string }) => {
    const db = openDb();
    const result = await parsePdf(db, pdf, opts.code, opts.title);
    console.log(`Ingested ${result.chapters} chapters into source #${result.sourceId}.`);
    console.log(`Run: npm run cli -- nodes` + ` to list them.`);
  });

program
  .command("ingest")
  .argument("<chaptersDir>", "directory of chapter-NN-*.md files (H1=chapter, H2=section)")
  .option("--code <code>", "book code, e.g. hb", "hb")
  .option("--title <title>", "book title", "Digital Marketing Handbook")
  .option("--seed-conflicts", "also seed known Appendix B errors as claim_conflicts")
  .action((chaptersDir: string, opts: { code: string; title: string; seedConflicts?: boolean }) => {
    const db = openDb();
    const result = parseMarkdownChapters(db, chaptersDir, opts.code, opts.title);
    console.log(`Ingested ${result.chapters} chapters into source #${result.sourceId}.`);
    if (opts.seedConflicts) {
      const n = seedKnownConflicts(db, opts.code);
      console.log(`Seeded ${n} known claim_conflicts from Appendix B.`);
    }
    console.log(`Run: npm run cli -- nodes` + ` to list them.`);
  });

program
  .command("nodes")
  .description("list curriculum nodes")
  .option("--kind <kind>", "filter by kind (book|chapter|section|concept)")
  .action((opts: { kind?: string }) => {
    const db = openDb();
    const rows = opts.kind
      ? db.prepare(`SELECT code, kind, title FROM curriculum_nodes WHERE kind=? ORDER BY id`).all(opts.kind)
      : db.prepare(`SELECT code, kind, title FROM curriculum_nodes ORDER BY id`).all();
    for (const r of rows as any[]) {
      console.log(`${r.code}\t${r.kind}\t${r.title}`);
    }
  });

program
  .command("retrieve")
  .argument("<query>", "search query")
  .option("-n, --limit <n>", "max results", "5")
  .option("--node <code>", "scope to a curriculum subtree, e.g. hb.1")
  .action((query: string, opts: { limit: string; node?: string }) => {
    const db = openDb();
    const results = retrieve(db, query, Number(opts.limit), opts.node);
    for (const r of results) {
      console.log(`[${r.nodeCode}] ${r.nodeTitle} (score ${r.score.toFixed(2)})`);
      console.log(r.text.slice(0, 200).replace(/\s+/g, " ") + "...\n");
    }
  });

program
  .command("conflicts")
  .description("list open claim conflicts (seeded handbook errors, etc.)")
  .action(() => {
    const db = openDb();
    const rows = db.prepare(`
      SELECT cc.id, n.code, cc.claim_a, cc.claim_b, cc.note
      FROM claim_conflicts cc
      LEFT JOIN curriculum_nodes n ON n.id = cc.node_id
      WHERE cc.status = 'open'
      ORDER BY cc.id
    `).all() as any[];
    for (const r of rows) {
      console.log(`#${r.id} [${r.code ?? "?"}]`);
      console.log(`  A: ${r.claim_a}`);
      console.log(`  B: ${r.claim_b}`);
      console.log(`  Note: ${r.note}\n`);
    }
  });

program
  .command("chat")
  .argument("<question>", "your question")
  .option("--node <code>", "scope to a curriculum subtree, e.g. hb.1 (recommended during a study session)")
  .action(async (question: string, opts: { node?: string }) => {
    const db = openDb();
    const chunks = retrieve(db, question, 5, opts.node);
    if (chunks.length === 0) {
      console.log("No material ingested yet, or no match. Run `harness ingest <pdf>` first.");
      return;
    }

    const context = chunks
      .map((c) => `[${c.nodeCode}] ${c.nodeTitle} (tier ${c.tier})\n${c.text}`)
      .join("\n\n---\n\n");

    const nodeCodes = chunks.map((c) => `'${c.nodeCode}'`).join(",");
    const conflicts = db.prepare(`
      SELECT cc.claim_a, cc.claim_b, cc.note
      FROM claim_conflicts cc
      JOIN curriculum_nodes n ON n.id = cc.node_id
      WHERE cc.status = 'open' AND n.code IN (${nodeCodes})
    `).all() as { claim_a: string; claim_b: string; note: string }[];

    const conflictBlock = conflicts.length
      ? `\n\nKNOWN CONFLICTS for these sections -- you MUST surface these if the topic comes up:\n` +
        conflicts.map((c) => `- Handbook claim: ${c.claim_a}\n  Correction: ${c.claim_b}\n  (${c.note})`).join("\n")
      : "";

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not set.");
      process.exit(1);
    }
    const anthropic = new Anthropic({ apiKey });

    const system = `You are a tutor answering strictly from the provided source chunks.
Every claim you make must carry a citation tag like [hb.1.4] matching the node code
of the chunk it came from. If the chunks don't answer the question, say so --
do not invent material. Do not state perishable claims (current law, pricing,
platform behavior) as fact without flagging them as unverified.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system,
      messages: [
        {
          role: "user",
          content: `Source chunks:\n\n${context}${conflictBlock}\n\n---\n\nQuestion: ${question}`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    console.log(text);
  });

program
  .command("status")
  .description("study-hours rule: study minutes vs build minutes this week")
  .action(() => {
    const db = openDb();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const dayStr = weekStart.toISOString().slice(0, 10);
    const row = db.prepare(
      `SELECT COALESCE(SUM(study_minutes),0) as study, COALESCE(SUM(build_minutes),0) as build
       FROM time_log WHERE day >= ?`
    ).get(dayStr) as { study: number; build: number };

    console.log(`This week: study ${row.study}m, build ${row.build}m.`);
    if (row.build > row.study) {
      console.log(`WARNING: build time exceeds study time. Study-hours rule violated -- study more before building more.`);
    }
  });

program
  .command("log")
  .description("log time spent")
  .requiredOption("--type <type>", "study|build")
  .requiredOption("--minutes <n>", "minutes spent")
  .action((opts: { type: string; minutes: string }) => {
    if (opts.type !== "study" && opts.type !== "build") {
      console.error("--type must be study or build");
      process.exit(1);
    }
    const db = openDb();
    const today = new Date().toISOString().slice(0, 10);
    const col = opts.type === "study" ? "study_minutes" : "build_minutes";
    db.prepare(
      `INSERT INTO time_log (day, ${col}) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + excluded.${col}`
    ).run(today, Number(opts.minutes));
    console.log(`Logged ${opts.minutes}m ${opts.type} for ${today}.`);
  });

// --- S1: learner loop primitives ---
// No standalone tutor/grader API call here (no API key available, only a
// claude.ai subscription login which doesn't grant API access). The tutor
// is Claude Code itself, live in the session -- these commands are the
// write path it uses, so status changes still go through code, not the
// tutor's own judgment (design principle 1).

function findNodeOrExit(db: ReturnType<typeof openDb>, code: string): { id: number; title: string } {
  const node = db.prepare(`SELECT id, title FROM curriculum_nodes WHERE code = ?`).get(code) as
    | { id: number; title: string }
    | undefined;
  if (!node) {
    console.error(`No curriculum node with code '${code}'. Run \`harness nodes\` to list them.`);
    process.exit(1);
  }
  return node;
}

program
  .command("concept")
  .description("add a concept node by hand (no auto-extraction -- add as you actually study)")
  .argument("<parentCode>", "parent section code, e.g. hb.1.3")
  .argument("<conceptCode>", "new concept code, e.g. hb.1.3.c1")
  .argument("<title>", "concept title")
  .action((parentCode: string, conceptCode: string, title: string) => {
    const db = openDb();
    const parent = findNodeOrExit(db, parentCode);
    db.prepare(
      `INSERT INTO curriculum_nodes (parent_id, kind, code, title, ordinal) VALUES (?, 'concept', ?, ?, 0)`
    ).run(parent.id, conceptCode, title);
    console.log(`Added concept ${conceptCode}: ${title}`);
  });

program
  .command("session-start")
  .description("start a study session focused on a node")
  .argument("<nodeCode>", "node to focus on, e.g. hb.1.3.c1")
  .action((nodeCode: string) => {
    const db = openDb();
    const node = findNodeOrExit(db, nodeCode);
    const id = db
      .prepare(`INSERT INTO sessions (focus_node_id, phase) VALUES (?, 'BOOT')`)
      .run(node.id).lastInsertRowid as number;
    console.log(`Session #${id} started on ${nodeCode} (${node.title}).`);
  });

program
  .command("session-end")
  .description("close a session (COMMIT phase) with a summary")
  .argument("<sessionId>", "session id")
  .argument("<summary>", "one-line session summary")
  .action((sessionId: string, summary: string) => {
    const db = openDb();
    db.prepare(`UPDATE sessions SET phase='COMMIT', ended_at=datetime('now'), summary=? WHERE id=?`).run(
      summary,
      Number(sessionId)
    );
    console.log(`Session #${sessionId} closed.`);
  });

program
  .command("evidence")
  .description(
    "record graded evidence for a node and apply status rules in code. " +
      "--score is a JSON rubric: {\"correct_labels\":0|1,\"causal_explanation\":0|1," +
      "\"quantified\":0|1,\"diagnosis_before_solution\":0|1,\"states_when_not\":0|1,\"label_errors\":N}"
  )
  .requiredOption("--node <code>", "node code")
  .requiredOption("--kind <kind>", "teach_back|transfer_case|review|quiz|imported")
  .requiredOption("--score <json>", "rubric score as JSON (ignored for 'imported')")
  .option("--session <id>", "session id this evidence belongs to")
  .option("--prompt <text>", "the prompt/question given")
  .option("--answer <text>", "the learner's answer")
  .action((opts: { node: string; kind: string; score: string; session?: string; prompt?: string; answer?: string }) => {
    const db = openDb();
    const node = findNodeOrExit(db, opts.node);
    const kind = opts.kind as EvidenceKind;
    const validKinds: EvidenceKind[] = ["teach_back", "transfer_case", "review", "quiz", "imported"];
    if (!validKinds.includes(kind)) {
      console.error(`--kind must be one of: ${validKinds.join(", ")}`);
      process.exit(1);
    }

    let score: RubricScore;
    try {
      score = JSON.parse(opts.score);
    } catch {
      console.error("--score must be valid JSON");
      process.exit(1);
    }

    const sessionId = opts.session ? Number(opts.session) : null;
    const confirmed = kind === "imported" ? 0 : 1;

    const evidenceId = db
      .prepare(
        `INSERT INTO evidence (node_id, session_id, kind, prompt, answer, grader_score, confirmed)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(node.id, sessionId, kind, opts.prompt ?? null, opts.answer ?? null, JSON.stringify(score), confirmed)
      .lastInsertRowid as number;

    const result = applyEvidence(db, node.id, kind, score, sessionId);
    console.log(`Evidence #${evidenceId} recorded for ${opts.node}.`);
    if (result.changed) {
      console.log(`STATUS CHANGE: ${result.from} -> ${result.to}`);
    } else {
      console.log(`Status unchanged (${result.from}).`);
    }
    console.log(`Reason: ${result.reason}`);
  });

program
  .command("learner")
  .description("show learner state for a node: status, evidence history, open misconceptions")
  .argument("<nodeCode>", "node code")
  .action((nodeCode: string) => {
    const db = openDb();
    const node = findNodeOrExit(db, nodeCode);
    const state = getConceptState(db, node.id);
    console.log(`${nodeCode} (${node.title})`);
    console.log(`  status: ${state.status}  stability: ${state.stability_days.toFixed(1)}d  lapses: ${state.lapses}`);
    console.log(`  first_working_at: ${state.first_working_at ?? "-"}  due_at: ${state.due_at ?? "-"}`);

    const evidenceRows = db
      .prepare(`SELECT kind, confirmed, grader_score, created_at FROM evidence WHERE node_id=? ORDER BY id`)
      .all(node.id) as { kind: string; confirmed: number; grader_score: string; created_at: string }[];
    if (evidenceRows.length) {
      console.log(`  evidence:`);
      for (const e of evidenceRows) {
        console.log(`    [${e.created_at}] ${e.kind} confirmed=${!!e.confirmed} score=${e.grader_score}`);
      }
    }

    const misconceptions = db
      .prepare(`SELECT belief, correction, cleared FROM misconceptions WHERE node_id=? ORDER BY id`)
      .all(node.id) as { belief: string; correction: string; cleared: number }[];
    for (const m of misconceptions) {
      console.log(`  ${m.cleared ? "[cleared]" : "[OPEN]"} misconception: "${m.belief}" -> ${m.correction}`);
    }
  });

program
  .command("misconception")
  .description("log a misconception caught during a session")
  .requiredOption("--node <code>", "node code")
  .requiredOption("--belief <text>", "what the learner believed")
  .requiredOption("--correction <text>", "the correction")
  .action((opts: { node: string; belief: string; correction: string }) => {
    const db = openDb();
    const node = findNodeOrExit(db, opts.node);
    const retestDue = new Date(Date.now() + 3 * 86400000).toISOString();
    db.prepare(
      `INSERT INTO misconceptions (node_id, belief, correction, source, retest_due_at) VALUES (?,?,?,'session',?)`
    ).run(node.id, opts.belief, opts.correction, retestDue);
    console.log(`Misconception logged for ${opts.node}, re-test due ${retestDue.slice(0, 10)}.`);
  });

program.parseAsync(process.argv);
