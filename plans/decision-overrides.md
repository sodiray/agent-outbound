# Plan: Human Decision Overrides

## Problem

The pipeline makes automated keep/drop/flag decisions per record at each gate. A human
operator reviewing the results needs to **override specific decisions** — both directions:

- "This lead was dropped by a gate, but I know it's good. Keep it and process it." (e.g. Metro
  Appraisals dropped by `address_gate`; FS8 Meridian dropped by a gate.)
- "This lead survived the pipeline, but I know it's not a fit. Drop it." (e.g. Medical Imaging Inc,
  PacWest Baseball.)

Today the only way to do this is to hand-edit the SQLite DB, which is invisible, un-auditable, and
gets silently undone by the next `pipeline --reapply` (filters re-evaluate and re-drop) or a clean
reset. We need a **holistic, systematic feature**: a durable, auditable, human-authored directive
that supersedes the pipeline's automated verdict for a specific record — and survives re-runs.

## Design principle

An **override is a first-class human directive, not a DB poke.** It is the source of truth for human
intent. Record state (`disqualified_*`, `needs_review`) is *derived* — the pipeline reconciles record
state to honor active overrides every time it runs. This is what makes overrides durable across
`--force`, `--reapply`, and full resets.

## Data model — `overrides` table (per-list `prospects.db`)

```sql
CREATE TABLE IF NOT EXISTS overrides (
  id          TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL,          -- _row_id
  kind        TEXT NOT NULL,          -- 'keep' | 'drop'
  step_id     TEXT DEFAULT '',        -- keep: gate to bypass; '' = all gates (protect). drop: always ''
  reason      TEXT NOT NULL,          -- required human rationale (auditable)
  created_by  TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  cleared_at  TEXT DEFAULT '',        -- soft-delete: '' = active (kept for audit history)
  cleared_by  TEXT DEFAULT '',
  FOREIGN KEY(record_id) REFERENCES records(_row_id) ON DELETE CASCADE
);
```

Active override = `cleared_at = ''`. Overrides live in the list DB alongside the leads, not in
`outbound.yaml` (they are per-lead human decisions, not pipeline definition). A normal reset that
clears `pipeline_events` / disqualification does **not** drop this table, so intent is re-applied on
the next run.

## Semantics

- **`keep` (scoped, `--step S`)** — force-pass gate `S` for this record. The record re-enters the
  in-play set and flows through the *rest* of the pipeline normally. It can still be dropped by a
  *different* gate (that's a different decision).
- **`keep` (blanket, `--all-gates`)** — record is immune to *all* drop gates → guaranteed survivor.
  Still gets enriched.
- **`drop` (`--reason`)** — disqualify the record regardless of pipeline verdict. Always blanket.

Both require `--reason`.

## Reconciliation (`reconcileOverrides`) — runs at the start of every `pipeline` run AND at create time

This is the durability guarantee. For each active override:

- **drop**: ensure the record is disqualified (`disqualified_gate = '__override__'`,
  `disqualify_reason = 'override: <reason>'`); clear any `needs_review`. `readInPlayRows`/`inPlayWhere`
  then naturally excludes it.
- **keep**: if the record is disqualified by an overridden gate (the specific `step_id`, or *any* gate
  for blanket), clear `disqualified_at/gate/reason` so it re-enters the in-play set; clear matching
  `needs_review`.

Create-time reconciliation makes `keep`/`drop` take effect immediately (a `drop` needs no run; a
`keep` un-disqualifies now and is fully processed on the next `pipeline` run — "process it").

## Runtime consultation (defense in depth, beyond reconciliation)

`runPipelineDataflow` loads active overrides for the in-play rows into
`overridesByRecord: Map<recordId, { keepAll: boolean; keepSteps: Set<string> }>` and consults it at
the two existing decision points:

1. **`initializeResolved`** — for `keep` overrides, add the kept drop-gate step ids (or *all* drop
   gates for `keepAll`) to the record's `initial` resolved set **unconditionally** (even under
   `--reapply`, which otherwise re-evaluates passed filters). The gate is treated as already passed,
   so it never runs.
2. **`onStepOutcome`** (filter branch) — if a drop gate fails for a record whose override covers this
   step, convert the verdict to a pass: write `pipeline_events(passed=1, reason='override: kept')`,
   skip `writeFilterFailure`, return `dropped:false`. Backstop for any record that reaches the gate
   before resolution.

`drop` overrides need no scheduler hook — reconciliation disqualifies them and `readInPlayRows`
excludes them.

## CLI surface — `override` command group

```
override keep  <list> <record> [--step STEP_ID | --all-gates] --reason TEXT
override drop  <list> <record> --reason TEXT
override clear <list> <record> [--step STEP_ID]
override list  <list> [--json]
override show  <list> <record>          # full decision history for one lead
```

`<record>` is resolved by `resolveRecordRef`: exact `_row_id`/`id`, else exact `business_name`
(case-insensitive), else `business_name` substring. Ambiguous match → error listing candidates so the
human disambiguates. This lets the operator reference leads by name ("Metro Appraisals").

`override show` surfaces: current disqualified/flagged state + reason + gate, the `pipeline_flags`
audit trail, and active/cleared overrides — the full "why is this lead where it is" picture.

`pipeline report` gains an **OVERRIDES** section (active keep/drop counts + entries) so a run's
human interventions are visible alongside its automated funnel.

### UI surface (viz `view`)

Every override carries a required reason, recorded in the DB and shown in the lead UI. The lead
detail panel (`getRecordDetail` → `App.tsx`) renders:

- a **Human overrides** section listing all overrides for the lead (keep + drop, active and cleared,
  with reason, scope, timestamp, author) — covers the drop override, which isn't tied to a gate;
- on each kept gate's step card, a **"Kept"** status badge plus an inline **Override · kept** note
  showing the reason and the auto-verdict it superseded;
- override entries in the lead timeline.

Multiple overrides per lead are fully supported and all displayed: e.g. keep gate A → keep gate B →
drop after scoring all coexist (the keeps show per-step, the drop in the overrides section). The
override data layer is append-only and merges multiple keeps per record.

## Files

- `src/orchestrator/runtime/db.ts` — `overrides` table in `SCHEMA_SQL`; `resolveRecordRef`;
  override CRUD/query helpers (`insertOverride`, `clearOverride`, `listActiveOverrides`,
  `getActiveOverridesForRecords`, `reconcileOverrides`).
- `src/orchestrator/pipeline/dataflow.ts` — load + reconcile overrides; thread `overridesByRecord`
  into `initializeResolved` and `onStepOutcome`.
- `src/commands/overrides.ts` — command implementations.
- `src/commands/index.ts` — re-export + OVERRIDES report section.
- `src/cli.ts` — `override` dispatch + help.
- `scripts/validate-overrides.mjs` — deterministic regression: resolver, keep survives `--reapply`,
  drop stays excluded, clear restores, blanket-keep immunity.

## Validation

1. `scripts/validate-overrides.mjs` (deterministic, temp DB).
2. Real end-to-end on `meridian-victory-eagle` (back up `prospects.db` first):
   - `keep` Metro Appraisals (`--step address_gate`) and FS8 Meridian.
   - `drop` Medical Imaging Inc and PacWest Baseball.
   - Re-run `pipeline --reapply` scoped; confirm the two keeps survive and the two drops are gone;
     `override list` and `pipeline report` reflect it.

## Out of scope (future)

- Override on enrich/errored steps (force a value); per-field overrides.
- Bulk override by `--where`.
- Expiry / TTL on overrides.
