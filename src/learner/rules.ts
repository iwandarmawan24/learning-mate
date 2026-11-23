// Status-change rules. Pure functions, no LLM involved -- the tutor (Claude,
// in a chat session) proposes evidence via `harness evidence add`; these
// rules decide whether concept_state actually changes. Spec section 3.
import type Database from "better-sqlite3";

export type Status = "unexplored" | "shaky" | "working" | "proven";
export type EvidenceKind = "teach_back" | "transfer_case" | "review" | "quiz" | "imported";

export interface RubricScore {
  correct_labels: 0 | 1;
  causal_explanation: 0 | 1;
  quantified: 0 | 1; // 1 if N/A for this prompt
  diagnosis_before_solution: 0 | 1;
  states_when_not: 0 | 1;
  label_errors: number;
}

export interface ConceptStateRow {
  node_id: number;
  status: Status;
  stability_days: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  first_working_at: string | null;
  lapses: number;
}

const PROVEN_MIN_GAP_DAYS = 3; // spec flagged: "2 sessions an hour apart" must not count

function rubricTotal(score: RubricScore): number {
  return (
    score.correct_labels +
    score.causal_explanation +
    score.quantified +
    score.diagnosis_before_solution +
    score.states_when_not
  );
}

function passesTeachBackBar(score: RubricScore): boolean {
  // unexplored|shaky -> working: rubric >= 3/4 effective criteria, <=1 label error.
  // (4 of 5 criteria scored; quantified is N/A-able, so treat total>=3 of remaining 4.)
  return rubricTotal(score) >= 3 && score.label_errors <= 1;
}

function passesTransferBar(score: RubricScore): boolean {
  // working -> proven requires the harder bar: quantified + diagnosis-before-solution
  // both required, not just "total score high enough".
  return (
    score.quantified === 1 &&
    score.diagnosis_before_solution === 1 &&
    rubricTotal(score) >= 4 &&
    score.label_errors === 0
  );
}

export function getConceptState(db: Database.Database, nodeId: number): ConceptStateRow {
  const existing = db
    .prepare(`SELECT * FROM concept_state WHERE node_id = ?`)
    .get(nodeId) as ConceptStateRow | undefined;
  if (existing) return existing;

  db.prepare(
    `INSERT INTO concept_state (node_id, status, stability_days, lapses) VALUES (?, 'unexplored', 1, 0)`
  ).run(nodeId);
  return db.prepare(`SELECT * FROM concept_state WHERE node_id = ?`).get(nodeId) as ConceptStateRow;
}

// Applies ONE piece of confirmed evidence to concept_state. Returns what changed
// (or didn't, and why) so the CLI/tutor can report it plainly -- no silent writes.
export function applyEvidence(
  db: Database.Database,
  nodeId: number,
  kind: EvidenceKind,
  score: RubricScore,
  sessionId: number | null
): { changed: boolean; from: Status; to: Status; reason: string } {
  const state = getConceptState(db, nodeId);
  const from = state.status;
  const now = new Date().toISOString();

  if (kind === "imported") {
    return { changed: false, from, to: from, reason: "imported evidence never changes status -- queues a re-test only" };
  }

  if (kind === "teach_back") {
    if ((from === "unexplored" || from === "shaky") && passesTeachBackBar(score)) {
      db.prepare(
        `UPDATE concept_state SET status='working', first_working_at=?, last_reviewed_at=?, updated_at=datetime('now') WHERE node_id=?`
      ).run(now, now, nodeId);
      return { changed: true, from, to: "working", reason: `teach_back passed rubric (score ${rubricTotal(score)}/4, ${score.label_errors} label errors)` };
    }
    if (from === "unexplored" || from === "shaky") {
      db.prepare(`UPDATE concept_state SET status='shaky', updated_at=datetime('now') WHERE node_id=?`).run(nodeId);
      return { changed: from !== "shaky", from, to: "shaky", reason: `teach_back did not pass rubric (score ${rubricTotal(score)}/4, ${score.label_errors} label errors)` };
    }
    return { changed: false, from, to: from, reason: "teach_back evidence only moves unexplored/shaky -> working" };
  }

  if (kind === "transfer_case") {
    if (from !== "working") {
      return { changed: false, from, to: from, reason: "transfer_case evidence only moves working -> proven" };
    }
    if (!passesTransferBar(score)) {
      return { changed: false, from, to: from, reason: `transfer_case did not pass the proven bar (needs quantified + diagnosis-first + 0 label errors)` };
    }
    // Needs confirmed transfer cases in 2 DIFFERENT sessions, with a real time
    // gap from when 'working' was first reached -- not two sessions an hour apart.
    if (!state.first_working_at) {
      return { changed: false, from, to: from, reason: "no first_working_at recorded -- data inconsistency, treating as not yet eligible" };
    }
    const daysSinceWorking = (Date.now() - new Date(state.first_working_at).getTime()) / 86400000;
    if (daysSinceWorking < PROVEN_MIN_GAP_DAYS) {
      return {
        changed: false,
        from,
        to: from,
        reason: `transfer_case passed but only ${daysSinceWorking.toFixed(1)}d since reaching 'working' -- needs >=${PROVEN_MIN_GAP_DAYS}d gap before 'proven' (retention, not one sitting)`,
      };
    }
    const priorPassingSessions = db
      .prepare(
        `SELECT DISTINCT session_id FROM evidence
         WHERE node_id = ? AND kind = 'transfer_case' AND confirmed = 1 AND session_id IS NOT NULL`
      )
      .all(nodeId) as { session_id: number }[];
    const distinctSessions = new Set(priorPassingSessions.map((r) => r.session_id));
    if (sessionId !== null) distinctSessions.add(sessionId);

    if (distinctSessions.size >= 2) {
      db.prepare(
        `UPDATE concept_state SET status='proven', last_reviewed_at=?, updated_at=datetime('now') WHERE node_id=?`
      ).run(now, nodeId);
      return { changed: true, from, to: "proven", reason: `transfer_case passed in ${distinctSessions.size} distinct sessions, ${daysSinceWorking.toFixed(1)}d gap` };
    }
    return { changed: false, from, to: from, reason: `transfer_case passed but only ${distinctSessions.size} distinct passing session(s) so far -- needs 2` };
  }

  if (kind === "review") {
    // FSRS-lite: pass -> stretch interval, fail -> lapse and drop from proven.
    const passed = passesTeachBackBar(score);
    if (passed) {
      const newStability = state.stability_days * 2.5;
      const dueAt = new Date(Date.now() + newStability * 86400000).toISOString();
      db.prepare(
        `UPDATE concept_state SET stability_days=?, due_at=?, last_reviewed_at=?, updated_at=datetime('now') WHERE node_id=?`
      ).run(newStability, dueAt, now, nodeId);
      return { changed: false, from, to: from, reason: `review passed, stability ${state.stability_days.toFixed(1)}d -> ${newStability.toFixed(1)}d` };
    }
    const droppedTo: Status = from === "proven" ? "working" : "shaky";
    db.prepare(
      `UPDATE concept_state SET status=?, lapses=lapses+1, stability_days=1, last_reviewed_at=?, updated_at=datetime('now') WHERE node_id=?`
    ).run(droppedTo, now, nodeId);
    return { changed: from !== droppedTo, from, to: droppedTo, reason: `review failed -- lapse recorded, status dropped` };
  }

  return { changed: false, from, to: from, reason: `quiz evidence is informational only, does not change status` };
}
