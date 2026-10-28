# Agent Outbound Viz Decisions

## Decisions

- Built `src/viz/ui/` as an isolated Vite 5 + React 18 + TypeScript mini-project with its own `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `node_modules`, and `dist`.
- Kept dependencies minimal: `react` and `react-dom` for rendering; `vite`, `typescript`, `@vitejs/plugin-react`, `@types/react`, and `@types/react-dom` for local development/build.
- Used a single global stylesheet with the pitch-deck tokens: `--bg: #05060a`, `--ink: #e8ebf2`, `--muted: #8b93a7`, accent yellow `#f5d547`, accent green `#3ecf6f`, translucent borders, dark card surfaces, and restrained transitions.
- Implemented server-side table filtering/sorting against the locked API contract. Enum filters are single-select because the API accepts one `filter.<key>` value per key; range filters use min/max number inputs.
- Default table columns are identity, priority, fit, trigger, and one status chip column for each filter/enrich pipeline step that exposes a `<step>__status` column. Additional columns are toggleable through the column picker.
- Detail drawer fetches `GET /api/records/:rowId` on demand and shows score axes, reasoning, criteria definitions/weights, priority blend math, per-step metadata, outputs, status filtering, and timeline.
- Updated `src/cli.ts` so `view` installs the isolated UI dependencies with `npm install --no-audit --no-fund` when `src/viz/ui/node_modules` is missing, then rebuilds and copies the UI when the served `dist/viz/ui/dist/index.html` bundle is missing, stale, or `--build` is passed.

## Assumptions

- The backend continues to serve `/api/meta`, `/api/records`, and `/api/records/:rowId` exactly as documented in `/Users/rayepps/projects/mission/plans/outbound-viz.md`.
- The source record may use either `business_name` or `name` and either `address` or `formattedAddress`; the table/detail UI checks both.
- `_created_at` is available for the Newest preset. If a list lacks `_created_at`, the backend currently falls back to its default sort handling rather than the UI selecting `sourced_at`.
- `src/viz/ui/dist` is ignored intermediate output. The root asset-copy step places that bundle under `dist/viz/ui/dist`, where the compiled Hono server reads it.

## Known gaps / risks

- Older records may lack persisted per-criterion score sub-values. The UI renders those criteria as not scored instead of inventing verdicts or points.
- The API query format does not define multi-value enum filters, so the v0 UI keeps enum filters single-value.
- The browser was not launched during validation per instruction; build output was verified, but visual/browser interaction testing remains with the orchestrator.
- The UI subproject currently has two moderate npm audit findings after install; no remediation was applied because the requested dependency set is intentionally minimal and build validation passed.

## Possible follow-ups

- Add API support for repeated enum filters or comma-delimited values, then upgrade enum controls to multi-select where useful.
- Add pagination or virtual scrolling if lists grow beyond the current 500-row fetch limit.
- Add a backend fallback for the Newest preset from `_created_at` to `sourced_at` when `_created_at` is absent.

## 2026-06-01 Per-Criterion Scoring

- Scoring now evaluates configured `score.fit.criteria[]` and `score.trigger.criteria[]` per criterion. The model returns only criterion verdicts (`yes`, `partial`, `no`) and reasoning; code normalizes criterion weights, maps verdicts to numeric values, computes axis scores deterministically, and keeps the previous single-axis score path when an axis has no criteria.
- Records now carry `fit_breakdown` and `trigger_breakdown` JSON columns. Each stores the criterion id, description, normalized weight, verdict, sub-score, points, and reasoning used by the viz API; `fit_score`, `trigger_score`, axis reasoning, priority rank, score events, overrides, and cost event step ids keep their existing semantics.

## 2026-06-01 Frontend Review Round 2

- Funnel legibility now has a fixed Outcome column and detail-header badge. Scored leads render as `Scored`; dropped leads render as `Dropped · <gate>` from `__stage`/`__dropped_at` with legacy disqualification fields as fallback. The header states how many leads passed the funnel, and the toolbar has a dropped-leads visibility chip backed by `filter.disqualified=qualified`.
- Score detail now renders the persisted per-criterion breakdown for Fit and Trigger: verdict chip, points, normalized weight, criterion reasoning, axis math, and the priority blend computation. Criteria without verdicts render as not scored instead of fabricating points.
- Detail steps now render as one left-rail timeline using `steps[]` order. The standalone `timeline[]` section is intentionally unused. Each node shows status, kind, timestamp, tool/server, model/provider/tokens/cost, decision text from `reasoning` or `condition_summary`, enrich outputs, and a terminal `Pipeline ended here` cap for dropped leads.
- Table filtering now uses progressive disclosure: free-text search stays visible, `+ Add filter` opens grouped fields from `meta.filters`, active filters render as removable chips with `Clear all`, and sorting moved into a compact `Sort` menu plus the Highest score/Newest presets.

## Round 2 Assumptions / Known Gaps

- Boolean filters are accepted defensively by the UI, but the current documented API still models most boolean-like filters as enum values.
- The timeline shows remaining steps as ghost not-reached nodes only when the backend includes those steps in `GET /api/records/:rowId`; the frontend does not synthesize missing pipeline steps from `meta`.
- The browser was not launched during validation per instruction. `npm run build` succeeded and regenerated `src/viz/ui/dist/index.html`.

## 2026-06-01 Frontend Review Round 3

- Detail step status now derives from funnel position in `src/viz/data.ts`: source is always `done`; dropped gates are `dropped`; pre-drop filters/enrich steps infer `passed`/`done`; trailing steps infer `not_reached`; explicit enrich statuses and filter events still win where the funnel rules allow.
- The detail timeline treats `done`/`passed`/`ok` as complete, `dropped`/`failed` as terminal red states, `flagged`/`skipped` as muted/yellow states, and `not_reached` as compact ghost nodes without empty descriptions, metadata, or output tables.
- Filter, sort, and column controls are controlled popovers with explicit Escape and outside-click dismissal and a higher stacking layer than the table.
- Metadata chips now render only when a real tool/server or cost event exists. Source keeps the Google Maps tool chip; free filters and not-reached steps omit noisy `n/a` token/cost rows.
- Empty boolean enrich outputs render as `—`; only real false values render `✗`, and score criterion names/descriptions now have explicit spacing.
- Round 4: Filter, sort, and column popovers now render through a fixed-position body portal anchored to their trigger buttons so the table and detail panel cannot clip them.

## 2026-06-02 Table Columns Round 5 — config-driven columns + frozen layout

**Problem.** The records table has ~136 columns: a fixed ~95-column engine base schema
(business_name/address/website/phone identity scaffold + scoring + a large mass of
outreach/sequence/email/mail/sms/visit/call/crm/compliance plumbing), PLUS dynamic columns
the source step accretes for EVERY scalar key the tool emits — so canonical columns and their
raw twins both exist (`website`+`websiteUri`+`domain`, `address`+`formattedAddress`,
`phone`+`nationalPhoneNumber`, `name`+`business_name`, `primary_type`+`primaryType`,
`place_id`+`placeId`+`google_place_id`, `lat`/`lng`+`latitude`/`longitude`). There is NO
display metadata in config. Defaulting to per-step `__status` chips (round ≤4) showed status,
not the data the user actually wants to read.

**Strategy (project-agnostic — the config is the schema of intent).** The only reliable signal
of "what THIS project gathers and how it scores" is the config itself, so column policy derives
from it, not from hardcoded name-sets:
- **Locked identity (frozen):** the business name (`business_name`, else `name`). One locked column.
- **Default-visible signal columns, in funnel order:** identity fundamentals that exist
  (address, website, phone — canonical, raw twins excluded because they are not output_map
  targets) → `fit_score` → every enrich step `outputs` field (pipeline order) → one derived
  verdict column per `score.{fit,trigger}.criteria` entry. Machine keys (lat/lng/place_id) and
  the ~70 outreach/lifecycle plumbing columns are NOT default-visible.
- **Everything else** stays available in the column picker (only the locked column is excluded
  from toggling).
Backend (`data.ts`) emits `default_visible` + `locked` per column, reorders `meta.columns` into
funnel order, appends virtual `criterion__<id>` (type `verdict`, group `criterion`) columns, and
`queryRecords` materializes `__outcome` + each `criterion__<id>` verdict onto every record.

**Layout.** Two frozen left columns (Outcome + Business name) via `position: sticky; left`; the
rest scroll horizontally like a spreadsheet. Outcome is icon-only (✓ scored / ⊘ dropped / ✕ error
/ ◌ processing / – not scored) with a `title`/`aria-label` hover tooltip; no header label.
Website renders as a truncated `<a>` (hostname) that `stopPropagation`s so it doesn't open the
drawer. Verdict columns render as Yes/Partial/No chips; non-score numeric columns render as plain
tabular numbers instead of the misleading 0–100 score bar. Default visible set now comes from the
backend `default_visible` flag, not a hardcoded list.

**`__outcome` precedence fix.** Error must rank BELOW scored: a fully scored lead can still carry
a non-fatal per-step `last_error` (e.g. a stale `timing_enrich` capture error). Order is
dropped → scored (has score timestamp / priority_rank>0 / fit_score>0) → error → not_scored.

**Implementation note.** A coherent backend pass (helpers + `derivedOutcome` + `queryRecords`
materialization, tsc-clean) was produced via Codex but the frontend (`App.tsx`, `styles.css`) and
the precedence fix were implemented and validated directly, since the sticky-column layout and the
config-derived classification were too subtle to hand off blind. Validated live in Chrome on
`e2e-victory-eagle`: frozen columns hold on horizontal scroll, verdict chips + SOS officer/date
render, detail panel intact. The view server caches `data.ts` at startup — restart it (not just
rebuild the UI) to pick up backend changes.

## 2026-06-02 Layout slimming Round 6 — flat chrome + compact header

- Removed the card chrome (border/background/glow/blur) from `.topbar`, `.toolbar`, and
  `.table-shell` — only `.detail-panel` keeps the surface card. Everything on the table page is
  now flat to reclaim vertical space.
- Top header is now a single compact row: left = project name (`meta.list.name`, small subtitle)
  over the project path (`meta.list.dir`, tiny monospace muted); right = the Total/Scored/Dropped
  stat chips. Dropped the "Agent Outbound" eyebrow, the large `h1`, and the funnel-description
  sentence (`.eyebrow`/`.funnel-context`/`h1` CSS left in place but unused).
- Scope was deliberately limited to header + card chrome; the table (frozen columns, links,
  verdict chips, detail panel) was left exactly as-is.

## 2026-06-02 Round 7 — three frozen columns (Outcome · Fit · Name)
- `fit_score` is now locked alongside `business_name` (`data.ts` buildMeta), so it's frozen and
  non-hideable in the column picker. Frozen order is Outcome → Fit → Business name; the rest scroll.
- Fit renders in its frozen column as a compact bold number (`FitFrozenCell`), not the score bar —
  tight enough for a 60px sticky column. Dropped/unscored rows show a muted "—".
- Sticky offsets: outcome left:0 (44px), fit left:44px (60px), name left:104px; the right-edge
  divider stays on the name column (last frozen).

## 2026-10-24 Pipeline canvas and review panel

- The viewer has a Pipeline route alongside the table. It presents the configured pipeline as an automatic top-down graph whose dependencies use the same explicit and inferred graph logic as validation; conditional branches and `on_event` turns stay visible as conditional edges and labelled per-event groups.
- Nodes show kind, identity, tool/model, live progression counts, recorded spend, and active-run state. Review nodes make a nonzero awaiting-decision count prominent.
- A selected node opens the existing standard right-side drawer over the canvas. Non-review drawers show definition, counts, and records at the step; review drawers provide the stage queue, record detail/timeline, editable `edit_fields`, previous/next navigation, decisions, and undo.
- Pipeline selection is deep-linkable with `step` and `record` query parameters. Review decisions use the same validation and mutation path as the CLI, including configured edit-field enforcement.

## 2026-10-25 Review stays on the Review page

- The pipeline page does not host review. A top-level review node's panel shows its definition, awaiting count, and a **Review Leads · N** button that opens `/review?stage=<stage_id>` with that tab active. Everything about review lives on the Review page; everything about the pipeline and its steps lives on the Pipeline page (product owner, 2026-10-25).
- The Review page carries its active stage tab in the URL (`?stage=`), so links from the pipeline and reloads land on the right tab.
- The decision-safety gate (`src/viz/review-gate.ts`) applies on the Review page: a decision targets only the record on screen (the selected row, or the open detail once it has loaded), one decision or undo is in flight at a time, Space/Enter on a focused control act on that control, and held keys never decide.
