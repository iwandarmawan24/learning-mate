import type Database from "better-sqlite3";

export interface RetrievedChunk {
  chunkId: number;
  nodeCode: string;
  nodeTitle: string;
  tier: string;
  text: string;
  score: number;
}

// FTS5 BM25 retrieve, swap-in point for pgvector hybrid search later (S3).
// nodeCodePrefix scopes to a curriculum subtree (e.g. "hb.1" during a Ch1
// study session) -- per spec section 5's retrieve(query, node?, tiers?).
// Matters for cross-referenced concepts: "exchange equation" is legitimately
// introduced in Ch1 and reused in Ch13 as a framework, so an unscoped query
// is a real tie between them. A session focused on Ch1 shouldn't see Ch13.
export function retrieve(
  db: Database.Database,
  query: string,
  limit = 5,
  nodeCodePrefix?: string
): RetrievedChunk[] {
  const words = tokenize(query);
  if (words.length === 0) return [];

  const scopeClause = nodeCodePrefix ? `AND (n.code = ? OR n.code LIKE ?)` : "";
  const scopeArgs = nodeCodePrefix ? [nodeCodePrefix, `${nodeCodePrefix}.%`] : [];

  const run = (ftsQuery: string) =>
    db.prepare(`
      SELECT c.id as chunkId, n.code as nodeCode, n.title as nodeTitle,
             s.tier as tier, c.text as text, bm25(chunks_fts, 10.0, 1.0) as score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN curriculum_nodes n ON n.id = c.curriculum_node_id
      JOIN sources s ON s.id = c.source_id
      WHERE chunks_fts MATCH ? ${scopeClause}
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, ...scopeArgs, limit) as RetrievedChunk[];

  // AND first -- a chunk matching every query word is almost always the
  // relevant one. A lone rare word (e.g. "funnel") in an unrelated short
  // chunk was outscoring the actually-relevant long section under a
  // pure-OR query (caught by the S0 graduation check: 3/10 wrong section).
  // Fall back to OR only when AND finds nothing.
  const andQuery = words.map((w) => `"${w}"`).join(" AND ");
  const andRows = run(andQuery);
  if (andRows.length > 0) return andRows;

  const orQuery = words.map((w) => `"${w}"`).join(" OR ");
  return run(orQuery);
}

// Minimal stopword list -- enough to strip question scaffolding ("what is
// the X") so AND-matching isn't forced to require literal "what"/"is"/"the"
// alongside the actual content words. Not exhaustive, not per-language;
// swap for a real tokenizer/stemmer if this keeps mattering past S0.
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "what", "which", "who", "whom", "how", "why", "when", "where",
  "do", "does", "did", "doing",
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "about",
  "and", "or", "but", "if", "as", "so",
  "this", "that", "these", "those", "it", "its",
  "i", "you", "he", "she", "we", "they",
  // generic question-framing words: present in natural phrasing but not
  // discriminating content -- requiring them in an AND match excludes the
  // actually-relevant chunk whenever it happens not to use that exact word.
  "work", "works", "mean", "means", "meaning", "understand",
  "difference", "between", "compare", "explain", "describe", "tell",
  "know", "concept", "about", "like",
]);

function tokenize(q: string): string[] {
  // \p{L}/\p{N} (Unicode letter/number) instead of A-Za-z0-9 so non-Latin
  // scripts (Indonesian diacritics, Arabic, CJK, etc.) aren't stripped.
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  const content = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return content.length > 0 ? content : words; // don't zero-out an all-stopword query
}
