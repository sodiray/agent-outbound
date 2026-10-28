# Viewer architecture

`agent-outbound view <list> [--port 7788]` serves an isolated Vite/React application from `src/viz/ui` through the Hono server in `src/viz/server.ts`. `src/viz/data.ts` is the viewer's SQLite/config read and write boundary. The CLI checks that the list database exists, rebuilds the UI when its bundle is missing or stale (or `--build` is supplied), copies the asset bundle into the server distribution, then starts the viewer server. This is separate from `agent-outbound serve`, which is the long-running action HTTP API and polling scheduler.

The React router keeps the table at `/` and mounts the pipeline at `/pipeline`. The pipeline adds the **Pipeline** navigation entry. Its selected step and record live in query state: `/pipeline?step=<id>&record=<row_id>`.

## Pipeline graph endpoint

`GET /api/pipeline` returns the complete graph and its live aggregates:

```json
{
  "nodes": [{
    "id": "quality_gate",
    "label": "Quality gate",
    "description": "…",
    "kind": "filter",
    "tool_or_model": "server · TOOL",
    "when": {"summary": "website is not empty and rating ≥ 4"},
    "inputs": ["…"], "outputs": ["…"],
    "depends_on": ["…"], "inferred_depends_on": ["…"],
    "review": {"fields": [], "edit_fields": [], "title_field": "…"},
    "group": {"id": "reply_turn", "label": "per event", "parent_id": "wait_for_reply"},
    "counts": {
      "waiting": 0, "passed": 0, "dropped": 0, "skipped_when": 0, "skipped_other": 0,
      "failed": 0, "blocked_by_error": 0, "errored": 0, "awaiting_review": 0
    },
    "spend_usd": 0.12, "spend_calls": 40, "unpriced_calls": 0
  }],
  "edges": [{"from": "source", "to": "quality_gate", "origin": "source"}],
  "groups": [{"id": "reply_turn", "label": "per event", "parent_id": "wait_for_reply"}],
  "active_step": "quality_gate",
  "unattributed_spend_usd": 0,
  "unattributed_spend": [
    {"step_id": "pipeline_enrich:removed_step", "spend_usd": 0.4, "calls": 12, "unpriced_calls": 0},
    {"step_id": "removed_unpriced_step", "spend_usd": null, "calls": 59, "unpriced_calls": 59}
  ],
  "unattributed_unpriced_calls": 59
}
```

`kind` is the configured step kind, with the UI mapping it to source, enrich/tool call, filter, decide, review, action, or wait presentation. `tool_or_model` is a concise summary of configured tool server/tool(s) or model. `when` is omitted when no predicate exists; its `summary` renders the field-check group as `field operator value` clauses joined by `and` (`match: all`) or `or` (`match: any`). `review` is present for configured review stages and carries their resolved `fields`, `edit_fields`, and `title_field`; only nodes with `review` show the Review Leads link. A review step inside an `on_event` block has no `review` (see [Review page and review API](#review-page-and-review-api)). Steps inside an `on_event` block become nodes with the id `<block>.<step>` and carry the block as their `group`; the group's `parent_id` is the step that opens the turn. The block itself is a group container, not a node.

The source node (`id: "source"`) lists the configured source strategies in `sources`, counts every sourced record as `counts.passed`, and breaks that total down by `records.source` (the strategy kind) in `source_counts`. Records do not carry the strategy id, so strategies of the same kind share one count.

The endpoint reads the configuration and constructs graph dependencies with `inferPipelineEdges` from `src/orchestrator/lib/pipeline-graph.ts`, the dependency logic validation uses. Dependencies declared in `depends_on` or `runs_after` are `explicit` edges; dependencies inferred from consumed fields (and positional review gates) that are not declared are `inferred` edges, and an inferred edge is marked `implied: true` when its target is already reachable from its source through other edges. A step with no dependencies gets an edge from the source node (`origin: "source"`), so the graph has a single root.

`active_step` comes from the latest `run_state` row, as in `getProgress`. It is set only while that row is `running`, its `updated_at` is under 8 seconds old (the table view's live-run rule), and its `active_step` is a pipeline node id; otherwise it is empty.

### Count sources

Counts are distinct records and partition the records that have reached a step. A record's state at a step is its latest `pipeline_events` row for that `(record_id, step_id)`, ordered by `occurred_at` then `rowid`, except that "not attempted" rows never replace an outcome. On each run, `dataflow.ts` writes a `passed = 0` row for every step the run did not attempt (`notAttemptedReason` / `onStepNotAttempted`), including steps the record resolved in an earlier run. Such a row says why the run passed the step by. It counts only when the record has no outcome row at the step.

| Count | Source of truth |
| --- | --- |
| dropped | Records with `disqualified_at` set and `disqualified_gate = step_id`, or, for a review stage, `disqualified_gate = '__override__'` with an active `drop` override created by `review:<step_id>`. A dropped record is counted only here at that step. The table API exposes the display-only aliases `__stage = 'dropped'` and `__dropped_at = disqualified_gate`; neither is a database column. |
| errored | The latest `errored_events` row for the record and step is at least as recent as the latest outcome row (or there is no outcome). The record must still be in play. |
| blocked_by_error | No outcome row, and the latest not-attempted row is `skipped:upstream_errored:<ids>`; the record is in play. |
| passed | Latest outcome has `passed = 1` and its reason is not a skip, or is `skipped:fresh` (cached result reused) or `skipped:provider_no_opinion:<…>` (the provider ran). A review park with an active `keep` override for the step, not yet reconciled, also counts as passed. |
| skipped_when | Latest outcome has `passed = 1` and the reason `skipped:<field-check reason>` from `skippedWhenOutcome` (`src/orchestrator/lib/step-when.ts`), or a manual park closed with `skipped:not_applicable:when_not_matched:<…>`. |
| skipped_other | Latest outcome has `passed = 1` and was skipped for a reason other than `when`: enrichment budget ceilings (`skipped:enrichment_ceiling`, `skipped:enrichment_budget_not_configured`, `skipped:enrichment_budget_tier_not_configured`), a manual park closed as no longer applicable (`skipped:not_applicable[:<…>]`), or an operator skip of a manual task (`kind = 'manual_task'`, `side_effecting = 1`). |
| waiting | Latest outcome is a park: `awaiting_review`, `awaiting_manual`, `awaiting_external_event`, `wake_at[:<…>]`, `Awaiting author step approval.`, or a draft pending approval. The record is in play and not opted out. For a review stage, `waiting` is the review queue count. |
| awaiting review | For a configured review stage: the exported `awaitingReviewWhere` predicate from `src/orchestrator/pipeline/review.ts` (the one `getReviewQueue` and the CLI use), evaluated for every review stage in one query grouped by stage, so it equals `GET /api/review/:stageId` `total`. |
| failed | Latest outcome has `passed = 0` and is neither a park nor a drop at this step: a gate that flagged rather than dropped, a soft non-pass such as `provider_returned_no_content`, or a rejected author approval. |
| spend | `SUM(cost_events.usd_cost)` per node, null when the node has only unpriced (null-cost) rows. `cost_events.step_id` is mapped to a node by stripping the writer prefix (`pipeline_enrich:`, `enrich:`, `pipeline_filter_batch:`, `pipeline_filter:`, `pipeline:compose:`, `generate:`); `sourcing:*` is source spend, and `<block>:<turn>:<step>` maps to an `on_event` step node. Any other id, such as a removed step, is listed in `unattributed_spend` with its `calls` and `unpriced_calls`; its priced spend is summed once in `unattributed_spend_usd` (`spend_usd` is null when none of its rows is priced), and its unpriced rows are summed in `unattributed_unpriced_calls`, so missing spend is visible rather than dropped. |

Not counted on a node: records that have not reached the step, meaning the latest row is a not-attempted reason other than `upstream_errored` (`skipped:record_dropped`, `skipped:unresolved_dependencies:<ids>`, `skipped:not_applicable`, `skipped:already_resolved`, `skipped:pending`, `skipped:not_time_ready`, `skipped:not_scheduled`, `skipped:unsupported_step_kind:<kind>`, `skipped:deferred_generate`, and the legacy `skipped:upstream_skipped:<ids>`). Also not counted are parks and errors of records that are no longer in play.

`on_event` step nodes count from `event_turn_steps` in each record's latest non-ignored turn. The mapping is:
- `passed` → passed;
- `skipped` with a `skipped:` reason → classified by the reason rules above;
- any other `skipped` → skipped_other;
- `awaiting_review` or `parked` → waiting, and also awaiting review for a review step;
- `errored` → errored.

Waiting and errored turn steps are counted only while the record is in play.

The current viewer's `GET /api/records` calculates `__furthest_step` from `pipeline_events.step_id` and derives `__stage`/`__dropped_at` from `records.disqualified_at`/`records.disqualified_gate`; those aliases remain table response fields, not persisted state.

## Records at a step

`GET /api/pipeline/steps/:stepId/records?state=<state>&limit=<n>&offset=<n>` provides the step panel list, where `state` is one of `waiting`, `passed`, `dropped`, `skipped_when`, `skipped_other`, `failed`, `blocked_by_error`, or `errored`. It returns `total` with a page of record rows (most recent state first, `extra_json` omitted, plus `__step_reason` and `__step_at`) and uses the same predicate as the corresponding graph count. A review stage's `waiting` list is the review queue page. Selecting a row calls the existing `GET /api/records/:rowId`, preserving the normal detail and timeline view.

## Review page and review API

Review happens on the Review page (`ReviewRoute.tsx`); the pipeline page only links to it. A top-level review node's panel shows its awaiting count and a **Review Leads** button that navigates to `/review?stage=<stage_id>`. The Review page reads `stage` from the query string to choose its active tab (falling back to the first review stage when the id is missing, unknown, or not a review stage), and writes it back with `replace` when the operator switches tabs, so reloads and shared links restore the tab. The all-stages tab is `stage=all` (`reviewTabFromParam` in `src/viz/review-presentation.ts`).

The review API serves `GET /api/review/:stageId?limit=<n>&offset=<n>&sort=<field>&dir=asc|desc&around=<row_id>` in pages. Membership is the exported `awaitingReviewWhere` predicate, and ordering, the total (`COUNT(*) OVER ()`), and paging run in one SQL statement, so a page costs the same at any offset or queue size. Sorting accepts `_row_id`, configured review `fields`, and any numeric `records` column (a numeric column type, a known numeric field, or a step output declared as a number), listed as `numeric_sort_fields`. The default order is park time then `_row_id`; a field sort orders by the quoted, schema-validated column then `_row_id`; a numeric sort casts values to numbers, puts empty values last, then `_row_id`.

With `around`, the response is the page that holds that record, whatever `offset` says, plus `around_position` (its zero-based queue position, or `null` when it is not awaiting this stage; the page is then the one at `offset`). 

A decision request carries edits with the record:

```json
{"decisions":[{"row_id":"row_42","verdict":"approve","reason":"","edits":{"owner":"Sam"}}]}
```

Each decision runs the CLI's own command, `reviewPassCommand` (`review approve --set field=value`) or `reviewDropCommand` (`review reject`) from `src/commands/review.ts`, so the viewer and the CLI share edit validation against `edit_fields`, the audit entry, the override, and reconciliation. The viewer adds two refusals before calling it: the record must be awaiting this stage now (`isRecordAwaitingReview`), so a stale screen cannot write an override that would pre-approve a record before it reaches the gate; and a reject may not carry edits, because `review reject` records none. A reject needs a reason, as in the CLI; the UI sends the standard reason when the operator leaves it blank. `DELETE /api/review/decisions/:rowId?stage=<stageId>` is undo and runs `reviewClearCommand` (`review clear`). Results are per row: one failed row does not stop the others.

Review steps inside an `on_event` block are decided per event turn: the CLI updates `event_turn_steps` and completes the turn on a reject, and lists them from open turns. The viewer has no queue with those semantics, so these nodes have no `review` block, open the read-only step panel with no Review Leads button, and have no Review page tab; and every review endpoint (queue, decisions, undo) refuses both the node id (`<block>.<step>`) and the bare step id with a 400 naming the block and the CLI command to use.

The Review page decides only the record it shows (`canDecide` in `src/viz/review-gate.ts`). With the detail drawer open, that is the drawer's record, and only once its detail has loaded: the drawer and Space / Enter / X decide nothing while it loads or while the previous record's detail is still on screen. With the drawer closed, it is the table row: the selected row for keys, or the row that holds the button. The record must be in the loaded queue, and no decision or undo may be in flight. The page has no reject reason or edit fields: a reject sends the standard reason and approvals carry no edits. Held keys repeat only J / K / ↑ / ↓; Space, Enter, X, and U act once per press (`reviewShortcut`). Space and Enter on a focused button (Enter also on a focused link) activate that control, never the selected row, and a held Enter does not click it again. Undo reverses the latest history entry at its own stage and record, never the current selection (`undoTargetFor`).

## Layout and live state

The pipeline uses React Flow (`@xyflow/react`) and dagre for a top-down automatic layout, then fits the graph on load. The UI connects to the existing `GET /api/stream` SSE endpoint; its one-second ticks carry `getProgress(...).run` and `getCounts(...)`. Pipeline refresh also re-fetches `GET /api/pipeline`, keeping node counts and `run_state.active_step` current while the page is open.

The standard `DetailDrawer` supplies the panel's slide-out, scrim, and Escape behavior, so a panel overlays rather than resizes the canvas.
