// Parses a PDF with a clean outline (chapter -> section) into curriculum_nodes
// and one chunk row per section. No LLM concept/prereq extraction at S0 --
// add kind='concept' nodes by hand as you actually study them.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type Database from "better-sqlite3";
import fs from "node:fs";

interface OutlineItem {
  title: string;
  dest: unknown;
  items?: OutlineItem[];
}

interface FlatNode {
  title: string;
  level: number; // 1 = chapter, 2 = section
  pageIndex: number;
}

export async function parsePdf(db: Database.Database, pdfPath: string, bookCode: string, bookTitle: string) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const outline = (await doc.getOutline()) as OutlineItem[] | null;

  if (!outline || outline.length === 0) {
    throw new Error("PDF has no outline/bookmarks. S0 parser requires one -- " +
      "export/regenerate the PDF with a table of contents, or add nodes by hand.");
  }

  const flat: FlatNode[] = [];
  for (const chapter of outline) {
    const pageIndex = await resolvePageIndex(doc, chapter.dest);
    flat.push({ title: chapter.title.trim(), level: 1, pageIndex });
    for (const section of chapter.items ?? []) {
      const sPageIndex = await resolvePageIndex(doc, section.dest);
      flat.push({ title: section.title.trim(), level: 2, pageIndex: sPageIndex });
    }
  }

  // full text per page, so sections can slice [startPage, nextNode.startPage)
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => it.str).join(" ");
    pageTexts.push(text);
  }

  const insertSource = db.prepare(
    `INSERT INTO sources (kind, tier, title, uri, fetched_at) VALUES ('material','T3',?,?,datetime('now'))`
  );
  const sourceId = insertSource.run(bookTitle, pdfPath).lastInsertRowid as number;

  const insertNode = db.prepare(
    `INSERT INTO curriculum_nodes (parent_id, kind, code, title, ordinal) VALUES (?,?,?,?,?)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (source_id, curriculum_node_id, ordinal, text) VALUES (?,?,?,?)`
  );

  const bookNodeId = insertNode.run(null, "book", bookCode, bookTitle, 0).lastInsertRowid as number;

  let chapterOrdinal = 0;
  let sectionOrdinal = 0;
  let currentChapterId: number | null = null;
  let currentChapterNum = 0;

  for (let i = 0; i < flat.length; i++) {
    const node = flat[i];
    const nextPageIndex = flat[i + 1]?.pageIndex ?? doc.numPages;
    const text = pageTexts.slice(node.pageIndex, nextPageIndex).join("\n\n").trim();

    if (node.level === 1) {
      chapterOrdinal++;
      sectionOrdinal = 0;
      currentChapterNum = chapterOrdinal;
      const code = `${bookCode}.${chapterOrdinal}`;
      currentChapterId = insertNode.run(bookNodeId, "chapter", code, node.title, chapterOrdinal).lastInsertRowid as number;
      if (text) insertChunk.run(sourceId, currentChapterId, 0, text);
    } else {
      sectionOrdinal++;
      const code = `${bookCode}.${currentChapterNum}.${sectionOrdinal}`;
      const sectionId = insertNode.run(currentChapterId, "section", code, node.title, sectionOrdinal).lastInsertRowid as number;
      insertChunk.run(sourceId, sectionId, 0, text);
    }
  }

  return { sourceId, bookNodeId, chapters: chapterOrdinal };
}

async function resolvePageIndex(doc: any, dest: unknown): Promise<number> {
  try {
    if (!dest) return 0;
    const explicitDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!explicitDest) return 0;
    const ref = (explicitDest as any[])[0];
    return await doc.getPageIndex(ref);
  } catch {
    return 0;
  }
}
