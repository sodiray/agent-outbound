# CRM layer, lead briefs, lifecycle states, field overrides

Driven by real field use (in-person prospecting off the treasure-valley list). Five feature
slices plus one urgent bug fix. Agent Outbound stays a reusable tool: everything
business-specific lives in config; the mechanics (tables, commands, lifecycle, merge rules)
are opinionated and built-in.

## What AO is opinionated about vs. configurable

**Opinionated (built-in, not configurable):**
- The lead lifecycle states and how they derive from existing columns.
- The interactions model (kinds, follow-ups, soft delete) and CLI verbs.
- Field-override mechanics: manual values always win over pipeline writes, forever.
- Briefs exist only for qualified leads; they refresh when material inputs change
  (same staleness discipline as enrich).

**Configurable (per-list YAML):**
- `business:` — who we are, what we sell, ICP, capabilities, the questions we always
  need answered before a walk-in.
- `brief:` — model, min score, prompt override, auto-generation toggle.
- Everything already configurable stays configurable.

## Phase 1 — Score integrity (bug fix, ships first)

1. **fit_score is dead but read everywhere.** `runScoring` writes the final capped score
   only to `priority_rank` (src/orchestrator/scoring/runner.ts:470); `fit_score` is a
   legacy column nothing writes since the single-score rework, so every freshly scored
   record shows `0.0`. Fix: write the final score to **both** `fit_score` and
   `priority_rank` (fit_score canonical, priority_rank back-compat). Audit every reader
   (viz/data.ts, map, report, export, record show) → prefer `fit_score`, fall back to
   `priority_rank`. One-shot backfill `fit_score = priority_rank` where divergent,
   applied automatically on db open (idempotent UPDATE).
2. **Re-score above the floor never clears the old drop.** Records disqualified by
   `score_minimum` in an earlier (broken-scoring) run stay DROPPED even after re-scoring
   75–100. Fix: in `runScoring`, when a record's score ≥ minimum and
   `disqualified_gate = 'score_minimum'`, clear `disqualified_at/gate/reason` and write a
   pipeline_event noting the reinstatement. Apply in both the rescored and
   skipped-unchanged branches.

## Phase 2 — Lead lifecycle status + manual field overrides

**Status.** One derive function, `leadStatus(record, overrides)`, in
`src/orchestrator/runtime/status.ts`, used by CLI `record show`, report, export, and viz
(list badge + filter, detail header, map). States:
- `unscored` — in-play, no score yet (score_updated_at empty)
- `qualified` — in-play, scored
- `dropped_low_score` — disqualified_gate = 'score_minimum'
- `dropped_gate` — any other pipeline gate
- `dropped_manual` — active `drop` override
No new mutable column; derived truth only.

**Field overrides.** New `field_overrides` table:
`override_id PK, row_id FK, field, value, reason, created_by, created_at, cleared_at, cleared_by`.
Latest active row per (row_id, field) wins. Mechanics:
- `lead set <list> <row_id> --field decision_maker_name --value "Teresa" [--reason ...]`
  writes the override AND immediately updates the record column.
- `lead unset <list> <row_id> --field X` (soft-clear), `lead overrides <list> <row_id>`.
- `applyOutputs` in enrichment/generate consults active overrides and **skips** writing
  any overridden field — pipeline reruns can never clobber a manual value.
- `reconcileFieldOverrides()` (mirror of reconcileOverrides) re-stamps values at the end
  of pipeline and score runs, belt-and-braces.
- Fields must be real records columns; reject unknown fields with the column list.
- Provenance: `record show` and viz mark manually-set fields.

## Phase 3 — Interactions & follow-ups (the CRM slice)

New `interactions` table:
`interaction_id PK, row_id FK, contact_id NULL, kind ('visit'|'call'|'email'|'meeting'|'note'),
summary, body, objections, follow_up_at, follow_up_done_at, follow_up_note,
created_by, occurred_at, created_at, updated_at, deleted_at`.

CLI:
- `interaction add <list> <row_id> --kind visit --summary "..." [--body ...]
  [--objections ...] [--follow-up YYYY-MM-DD] [--occurred-at ...]`
- `interaction list <list> [--row ID] [--kind K] [--due] [--overdue]`
- `interaction show / edit / done / remove` (done = stamp follow_up_done_at;
  remove = soft delete)
- `followups <list>` — open follow-ups across the list, overdue first.
Convention: an open follow-up also sets `records.next_action_date` to the earliest open
follow-up date for that record (cleared/recomputed on done/remove).

Viz: detail panel gains an **Interactions** section (chronological cards: kind, summary,
body, objections, follow-up chip with due/overdue state); timeline merges interactions;
list view shows a follow-up-due indicator.

## Phase 4 — Business context + lead briefs

**Config, top-level `business:`** (all optional; AO works without it):
`name, description, icp, offer, capabilities (list), field_questions (list), context`
— exposed to all prompt rendering as `business.*` args.

**Config, top-level `brief:`**:
`enabled (default false), model (default ai.default_model), min_score (default
score.minimum), prompt_file (optional override of built-in prompt), auto (default true —
run after scoring), cache_key`.

**Storage.** `lead_briefs` table:
`brief_id PK, row_id UNIQUE FK, summary (the 1–3 sentence SDR verdict), content
(full markdown), roles_json (structured: roles present → automatable workflows),
dep_hash, model, status ('ready'), created_at, updated_at`.

**Built-in prompt** (overridable): an SDR/sales-expert take on this specific lead for
*our* business, grounded in the record + enrichment outputs (site profile, franchise,
decision makers) + score breakdown + business config + recent interactions. Embeds the
role-researcher lens: workflows have anatomy (trigger, inputs, steps, tools, output,
cadence); pain clusters into named failure modes (re-keying, reconciliation, chasing,
manual compilation, spreadsheet-as-database, format translation); every problem traces
to business impact. Required sections:
1. **Verdict** — quality of this lead for us, one paragraph, no hedging.
2. **Business snapshot** — what they do, size, how they likely operate.
3. **Roles & automatable workflows** — the roles likely inside, each with the concrete
   admin workflows we could automate (this also fills roles_json).
4. **Top automation opportunities** — best 3, with the pitch angle.
5. **Walk-in brief** — who to ask for, what to say, the opener.
6. **Likely objections** — and how to answer them.
7. **Field questions** — answers to business.field_questions where inferable; what to
   ask to learn the rest.
Inference must be labeled as inference; never fabricate names/facts.

**Runner.** `brief <list> [--where SQL] [--force]` command; generates only for
`qualified` leads with score ≥ brief.min_score. dep_hash over material inputs (identity
fields, enrichment outputs, score, business+brief config, latest interaction) — same
staleness discipline as enrich, so re-running after a logged interaction regenerates the
brief with the field intel folded in. Auto-hook: end of `runScoring` (and lead add --run)
generates briefs for the just-scored qualified rows when brief.enabled && brief.auto.

**Viz.** Brief renders at the very top of the lead detail panel: summary verdict
prominent, full content expandable. Brief presence/absence visible in list view.

## Validation & rollout (operator, not Codex)

After each phase: `npx tsx src/cli.ts` smoke against the treasure-valley list
(db backed up first), commit to main. Then: write `business:` + `brief:` into
treasure-valley outbound.yaml; migrate notes.md (Apex/Teresa visit + 2026-06-11
follow-up) into interactions + field overrides; backfill scores; let re-score clear the
stale score_minimum drops; generate briefs for the ≥85 cluster and review Apex + Idaho
Custom Rain Gutters by hand.
