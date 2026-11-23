# Learning Harness

A coded harness that turns a foundation model into a persistent learning partner, built against the [Learning Harness Spec v0.1](#).

Core principle: **the model proposes, code decides.** The tutor (Claude) can propose evidence that a concept was understood, but status changes in the learner model are applied by deterministic rules in code, after a rubric score — never by the tutor's own judgment.

## Stage status

- **S0 (knowledge spine):** done. SQLite + FTS5 retrieval over curriculum nodes (book → chapter → section), markdown ingestion, citation-tagged CLI chat, seeded claim conflicts from source material.
- **S1 (learner loop):** core write path done. `concept_state` / `evidence` / `misconceptions` tables, status-change rules (`unexplored|shaky → working → proven`), time-gated `proven` transitions, session tracking. No standalone API-driven tutor yet — sessions run interactively (tutor in a coding-agent chat, writing evidence via the CLI).
- **S2+:** not started (conversation import, research/TTL cache, external sources, web UI, review scheduling).

## Setup

```bash
npm install
npm run cli -- ingest <chapters-dir> --code hb --title "<book title>" --seed-conflicts
```

Chapters directory expects one markdown file per chapter, `# Chapter N: Title` as H1, `## N. Section` as H2. H3 subsections are chunked individually for retrieval (H2 stays the citation unit, e.g. `[hb.1.3]`).

## CLI

```bash
# knowledge spine
npm run cli -- nodes [--kind book|chapter|section|concept]
npm run cli -- retrieve <query> [-n <limit>] [--node <code>]
npm run cli -- conflicts
npm run cli -- chat <question> [--node <code>]   # needs ANTHROPIC_API_KEY in .env

# learner loop
npm run cli -- concept <parentCode> <conceptCode> <title>
npm run cli -- session-start <nodeCode>
npm run cli -- session-end <sessionId> <summary>
npm run cli -- evidence --node <code> --kind teach_back|transfer_case|review|quiz|imported --score '<rubric json>' [--session <id>]
npm run cli -- learner <nodeCode>
npm run cli -- misconception --node <code> --belief <text> --correction <text>

# study-hours rule (build time should not exceed study time)
npm run cli -- log --type study|build --minutes <n>
npm run cli -- status
```

### Rubric JSON shape (for `evidence --score`)

```json
{
  "correct_labels": 0,
  "causal_explanation": 0,
  "quantified": 0,
  "diagnosis_before_solution": 0,
  "states_when_not": 0,
  "label_errors": 0
}
```

## Status-change rules (`src/learner/rules.ts`)

- `unexplored|shaky → working`: one confirmed `teach_back` scoring ≥3/4 criteria with ≤1 label error.
- `working → proven`: confirmed `transfer_case` evidence in **2 distinct sessions**, with **≥3 days** since first reaching `working` (prevents "proven in one sitting"), quantified + diagnosis-before-solution both required, 0 label errors.
- `review`: pass → stability stretches ×2.5; fail → lapse recorded, drops a tier.
- `imported` evidence never changes status — it only queues a re-test.

## Data

SQLite at `data/harness.db` (gitignored — contains ingested source material, not committed). Schema in `src/db/schema.ts`.
