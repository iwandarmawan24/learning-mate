import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.join(process.cwd(), "data", "harness.db");

export function openDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    -- Knowledge
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('material','conversation','research','external')),
      tier TEXT NOT NULL CHECK(tier IN ('T1','T2','T3','T4','T5')),
      title TEXT NOT NULL,
      uri TEXT,
      author TEXT,
      published_at TEXT,
      fetched_at TEXT,
      ttl_days INTEGER,
      checksum TEXT,
      meta TEXT
    );

    -- Curriculum: chapter/section only at S0. kind='concept' rows are added
    -- by hand as you actually study them -- no auto prereq-edge extraction.
    CREATE TABLE IF NOT EXISTS curriculum_nodes (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES curriculum_nodes(id),
      kind TEXT NOT NULL CHECK(kind IN ('book','chapter','section','concept')),
      code TEXT NOT NULL UNIQUE,     -- e.g. hb.1.3
      title TEXT NOT NULL,
      summary TEXT,
      ordinal INTEGER NOT NULL DEFAULT 0
    );

    -- Section/chunk text. One row per H3 subsection (falls back to whole H2
    -- section when there's no H3). heading is stored separately so retrieve()
    -- can weight it -- a query matching the heading phrase ("the exchange
    -- equation") should beat the same words appearing incidentally in an
    -- unrelated chunk's body, which plain single-column BM25 gets backwards
    -- (shorter incidental chunk wins on length normalization alone).
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id),
      curriculum_node_id INTEGER REFERENCES curriculum_nodes(id),
      ordinal INTEGER NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      meta TEXT
    );

    -- FTS5 index over chunk heading+text, used by retrieve() instead of
    -- pgvector at S0. heading gets a higher bm25() column weight at query time.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      heading,
      text,
      content='chunks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES('delete', old.id, old.heading, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES('delete', old.id, old.heading, old.text);
      INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
    END;

    CREATE TABLE IF NOT EXISTS claim_conflicts (
      id INTEGER PRIMARY KEY,
      node_id INTEGER REFERENCES curriculum_nodes(id),
      claim_a TEXT NOT NULL,
      claim_b TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
      resolved_by_source INTEGER REFERENCES sources(id)
    );

    -- Learner model. Status only meaningful on kind='concept' nodes --
    -- chapter/section rows never get a concept_state row.
    CREATE TABLE IF NOT EXISTS concept_state (
      node_id INTEGER PRIMARY KEY REFERENCES curriculum_nodes(id),
      status TEXT NOT NULL DEFAULT 'unexplored'
        CHECK(status IN ('unexplored','shaky','working','proven')),
      stability_days REAL NOT NULL DEFAULT 1,
      due_at TEXT,
      last_reviewed_at TEXT,
      first_working_at TEXT,   -- set when status first becomes 'working';
                                -- proven requires a transfer-case gap from this date
      lapses INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES curriculum_nodes(id),
      session_id INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('teach_back','transfer_case','review','quiz','imported')),
      prompt TEXT,
      answer TEXT,
      grader_score TEXT,  -- JSON: per-criterion 0/1 + label_errors count
      grader_model TEXT,
      confirmed INTEGER NOT NULL DEFAULT 0,  -- imported evidence is always 0
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS misconceptions (
      id INTEGER PRIMARY KEY,
      node_id INTEGER REFERENCES curriculum_nodes(id),
      belief TEXT NOT NULL,
      correction TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('session','imported')),
      retest_due_at TEXT,
      cleared INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS open_questions (
      id INTEGER PRIMARY KEY,
      node_id INTEGER REFERENCES curriculum_nodes(id),
      text TEXT NOT NULL,
      origin TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      focus_node_id INTEGER REFERENCES curriculum_nodes(id),
      phase TEXT NOT NULL DEFAULT 'BOOT',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      citations TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY,
      node_id INTEGER REFERENCES curriculum_nodes(id),
      session_id INTEGER REFERENCES sessions(id),
      kind TEXT NOT NULL CHECK(kind IN ('mermaid','html','svg')),
      title TEXT,
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    -- Study-hours rule enforcement (spec section 8): one row per day,
    -- study_minutes vs build_minutes. harness status reads this.
    CREATE TABLE IF NOT EXISTS time_log (
      day TEXT PRIMARY KEY,   -- YYYY-MM-DD, ISO week start also derivable
      study_minutes INTEGER NOT NULL DEFAULT 0,
      build_minutes INTEGER NOT NULL DEFAULT 0
    );
  `);
}
