# Pipeline-Centric Model

Design outline for four pieces of work that together turn Agent Outbound from a single-source,
single-sequence tool into a multi-source, router-driven pipeline where every lead is a company,
people attach to companies, and a sequence is nothing but pipeline steps.

## Context

Two facts, both verified against the running system, motivate all four items.

**A LinkedIn-sourced lead cannot enter today's pipeline.** harvestapi returns a person: full name,
headline, geography, an opaque profile URN. It returns no `primary_type`, no `website`, no address,
no review count. Every gate in the live pipeline reads a Google-Places-shaped field. Mapping the
gates against what a harvestapi lead actually carries:

| Gate | Reads | LinkedIn lead |
| --- | --- | --- |
| `vertical_gate` | `primary_type not_in [...]` | **vacuous pass** |
| `real_site_gate` | `website is_not_empty` | dropped |
| `has_website_gate` | `website is_not_empty` | dropped |
| `has_reviews_gate` | `user_rating_count is_not_empty` | dropped |
| `address_gate` | `address_rdi neq Residential` | vacuous pass |
| `locally_sellable_gate` | `is_franchise neq true` | vacuous pass |

The vacuous passes are the dangerous half. In `lib/conditions.ts`, the `not_in` branch normalizes the
candidate value and filters empties out of the target list, so an empty `primary_type` can never
match the blocklist and `passed = !matched` returns true. The medical / education / lodging / worship
blocklist does not reject a stub lead — it has nothing to check and reports a pass.

**Multi-sequence is silently broken two ways.** `config.sequences` is already a keyed map and
`records.sequence_name` already exists as a column, but nothing binds them:

- `sequencer/runner.ts` `runSequencer` selects records with `SELECT * FROM records WHERE
  <inPlayWhere>` — no `sequence_name` filter — then runs all of them through the single sequence
  named by its caller. Both top-level entry points pass `'default'`.
- `getSequence` is `sequences[name] || sequences.default || { steps: [] }`. An unknown name silently
  becomes `default`, which for a list whose default has `steps: []` means zero sends, zero errors,
  and a clean summary.

Everything below is shaped by one recurring property of this codebase: **its failures are
success-shaped.** A dead vendor returned `Unknown` and left a filter inert for seven weeks.
`refresh-tools` emptied a tool while reporting `ok: true, unresolved: 0`. A hand-repaired record
reported `processed: 0` as a clean run. Design and validation both have to assume that "it ran and
nothing complained" carries no information.

## Scope

Four items. The dependency order below is not the order they were conceived in; it is the order in
which each one's assumptions are satisfied by the one before it.

---

## 1. Contacts model and the resolved-company invariant

### Context

`records` is a company row with exactly one flattened contact: `contact_name`, `contact_title`,
`contact_name_primary`, `contact_title_primary`, `owner_name`, `contact_email`, `persona`,
`crm_person_id`. Person-first sourcing produces several people at one company, and the shared
pipeline needs a guarantee that the company fields it reads are real rather than absent.

### Scope

- A `contacts` table, one-to-many against `records`, carrying `row_id`, `full_name`, `first_name`,
  `last_name`, `title`, `seniority`, `linkedin_url`, `linkedin_urn`, `email`, `email_status`,
  `phone`, `source`, `source_query`, `sourced_at`, `is_primary`, `confidence`.

  **Correction, found during implementation:** this table already existed (`db.ts`, with `upsertContact`,
  `listContactsByRecord` and `getPrimaryContact` already wired) — the same pattern as `sequence_name`,
  where the schema anticipates a feature nothing binds. The actual blocker was narrower and worse than
  a missing table: `upsertContact` opened with `if (!rowId || !email) return false`, and a UNIQUE index
  on `(row_id, email)` collided on the empty string. The whole subsystem was **email-keyed**, and every
  harvestapi contact has no email — so attaching three LinkedIn people returned `false` three times and
  wrote zero rows, silently. The work is therefore an identity rework, not a new table.
- The existing flattened `contact_*` / `owner_name` fields become **derived projections of the
  primary contact** rather than storage. Gates, briefs, sequence templates, the CRM sync, and the
  review UI all read them today; keeping them as a projection avoids a big-bang rewrite and keeps
  the change reversible.
- `records.company_resolution`: `resolved | stub | unresolvable`. Plus `resolution_source`
  (`places | manual | none`) for attribution.
- A new first step in the shared pipeline: `company_resolved_gate`, a `field_check` asserting
  `company_resolution eq resolved`. Positioned first, so every existing gate inherits it.
- Rewrite the `decision_makers` enrich step. Today it runs a Hunter domain search and then spends a
  Llama-3.3-70B call to "select the single best B2B outreach decision-maker," emitting singular
  `decision_maker_name` / `_title` / `_email`. That selection exists only because the schema holds
  one contact. With a real contacts table it attaches every result and sets `is_primary`
  deterministically (seniority rank, then email presence) — deleting a model call rather than
  adding one.

### Decisions

- **The company is the record; a person is evidence attached to it.** Not a polymorphic
  `lead = person | company`. Every gate would have to branch, review would need two layouts, and it
  fights the actual motion — you walk into a business, you sell to a business, you dedupe a business.
- **Agent Outbound is B2B-only.** This is now an explicit product assumption, not an emergent one.
- **Stub companies never enter the shared pipeline**, for two independent reasons: the gates
  vacuously pass them, and the LLM dedupe (`same` / `confidence`, 0.7 threshold) cannot reliably
  compare a bare company-name string to a canonical record, so stubs land as `needs_review`
  duplicates and pollute dedupe.
- Flattened fields are projected, not dropped.
- **Primary selection must be deterministic with no random component.** Found by validation: the first
  implementation ranked by seniority *after* falling through `created_at`, which ties at millisecond
  resolution, so a `Math.random()`-generated `contact_id` decided the winner — the same fixture chose
  `Owner` in 2 of 8 runs and `Office Manager` in 6. A flaky primary means a flaky projection, which
  means a sequence addressing a different person on a re-run. Seniority is the first sort key, and no
  generated id may influence it.

### Traps worth knowing before touching this

- `records` base columns include `google_place_id`, **not** `place_id`, and **`primary_type` is not a
  base column at all** — it is declared per-list in `outbound.yaml`. Anything that references either
  (a backfill, a gate, a rule) must tolerate its absence, or it throws on a fresh list.
- Additive migrations here follow `try { db.exec("ALTER TABLE ... ADD COLUMN ...") } catch {}`, which
  swallows the error. That is idempotent by design, but it means a failed migration is silent.

---

## 2. The router

### Context

The system needs several sequences per list — mechanical/electrical engineering firms, commercial
real estate, dental, a high-signal dental variant gated on score — and something that decides which
one each lead enters. Today defining a second sequence is unsafe for the two reasons in Context
above, and both fail silently.

### Scope

**Fix the two existing defects first.**

- `getSequence` drops its `|| sequences.default` fallback. An unknown name raises.
- `runSequencer` groups due records by their own `sequence_name` and resolves each group's sequence
  independently. `--sequence <name>` becomes a *filter*, not the selector. `launchDraft` likewise. A
  record carrying an undefined `sequence_name` raises rather than falling back.

**Add a step kind: `assign`.** Named `assign` rather than `route` because `routes` and
`sequence:plan_route` already mean drive-route planning for the field motion.

```yaml
- kind: assign
  id: sequence_assign
  depends_on: [score]        # must name whatever produces the fields the rules read
  target: sequence_name
  fallback: unrouted
  rules:                     # first match wins
    - sequence: dental_high
      match: all
      conditions:
        - {field: primary_type, operator: in, value: [dentist, dental_clinic]}
        - {field: score, operator: gte, value: 80}
    - sequence: dental
      conditions:
        - {field: primary_type, operator: in, value: [dentist, dental_clinic]}
```

Each rule reuses the existing `match` / `conditions` shape, so `type: semantic` rules come free at
tier 1. Field rules are preferred: semantic conditions serialize the whole record into the prompt.

- The step writes `sequence_name`, a `pipeline_events` row (so it resolves and is idempotent like
  every other step), and `routed_by` naming the matched rule.
- **The step is a no-op once `sequence_status != 'idle'`.** Otherwise editing rules yanks launched
  leads between sequences mid-send.
- Placement: before the review barrier, after scoring. It is tier 0 and free, and it lets the review
  UI show the destination while a human is deciding.

**Validation, enforced at `validate` time so it precedes any spend.**

| Rule | Severity |
| --- | --- |
| Multiple sequences defined, no `assign` step | error |
| `rules[].sequence` names an undefined sequence | error |
| `fallback` names a sequence with non-empty `steps` and no `manual: true` | error |
| A rule reads a field no `depends_on` step produces, and which is not a source field | error |
| A defined sequence is unreachable from every rule | warn |
| An earlier rule's conditions are a strict subset of a later rule's on the same fields | warn |

The fourth is the highest-value check. Routing on `score` before scoring runs sends every lead to the
fallback with no error — one large silent pile that reads as a routing-logic problem.

**Holding pen.** `unrouted` records are skipped by the sequencer entirely, surfaced in review as a
bucket with a manual assign control. `review stages` gains per-sequence counts so a growing pen is
visible rather than inferred.

### Decisions

- **Ambiguity is an error, not a silent pick.** One sequence and no `assign` step behaves exactly as
  today with zero new config; the feature costs nothing until used. Defining a second sequence
  without a router is refused rather than guessed at.
- **The router targets a pipeline, not merely a sequence.** Sub-pipeline step ids are namespaced
  (`dental.wait_3d`) because `pipeline_events` is keyed by `step_id` — recursive in config, flat in
  the event log.

---

## 3. Sequences as pipeline steps

### Context

`sequencer/runner.ts` reimplements a weaker copy of the dataflow engine: its own record selection,
its own advancement, its own idempotency, its own timing. The pipeline engine already has step
resolution via `pipeline_events`, `depends_on`, tiering, staleness, and cost accounting. A sequence
needs all of it.

### Scope

- **A third readiness dimension.** Today: `dataReady` (dependencies resolved) and
  `economicallyReady` (tier and budget). Add `timeReady`, with `wake_at` as a first-class not-ready
  reason recorded in `pipeline_events`. `records.next_action_date` becomes derived rather than
  authoritative. This single primitive is what collapses the sequencer into the engine.
- **Sequence-flavored step kinds**, so a UI can render a sequence as a sequence and validation can
  reason about it: `wait`, `send_email`, `send_sms`, `linkedin_connect`, `manual_task`, `exit`.
  `exit` needs no new machinery — it is a filter whose failure disqualifies.
- `working_days` and `non_working_day_policy` move from sequence-level config into the resolution of
  a `wait` step.
- **`side_effecting: true` on any step that emits externally.** The current repair procedure for a
  stuck record is deleting its `pipeline_events` and staleness rows to force a re-run. Once a send is
  a pipeline step, that same move sends the email a second time. The re-run machinery must refuse to
  clear a side-effecting step; clearing one requires an explicit, loud override.
- Preserve the capability that motivates the whole item: filters and enrichments interleave between
  sends. Wait three days, re-scrape, exit if the site now says acquired, then send. No conventional
  sequencer can express that.

### Decisions

- **Sends are pipeline steps but are not idempotent.** The re-run machinery has to know the
  difference. This is the highest-blast-radius behavior in the four items.
- Sequence steps are a *flavor* — for UI and validation — not a separate execution path.

### Two limitations of the side-effect guard, found during implementation

Both are real and neither is closed. Recording them because a guard people believe is total is worse
than one whose edges are known.

- **The guard protects the code path, not the database.** It fires only for callers of
  `clearStepState`. Repairing a stuck record with raw SQL against `pipeline_events` / `staleness`
  bypasses it completely — and raw SQL is how stuck records have actually been repaired here before.
  So the documented repair procedure must route *through* `clearStepState` with an explicit
  `allowSideEffectingClear`, never around it. A guard that only covers the polite path is not a
  guarantee.
  What makes it survive config drift, at least: `side_effecting` is recorded on the
  `pipeline_events` row itself, not read from the current config, so editing a step to drop the flag
  cannot retroactively unprotect a send that already went out.
- **There is an exactly-once gap the guard cannot close.** If the process dies after the provider
  accepts a send but before its completed `pipeline_events` row is written, the send happened and
  the pipeline does not know it. The next run re-sends. This is at-least-once delivery, and no
  clearing guard can fix it — closing it needs either an outbox (persist intent before dispatch,
  reconcile after) or provider-side idempotency keys. Until then, a crash mid-send can duplicate a
  message to a customer.

### A latent hazard worth naming

`runDataflowCore` defaults `isTimeReady` to `() => true`. Today the only production caller,
`runPipelineDataflow`, injects a real implementation — but a permissive default on a *timing* gate is
the same shape as `not_in` passing vacuously on an empty field: a future caller that omits the
parameter gets instantly-ready `wait` steps and sends that fire early, with nothing failing loudly.
Prefer making it required so the compiler catches the omission.

---

## 4. The LinkedIn lane

### Context

Measured, not assumed. `apify /harvestapi/linkedin-profile-search-by-services` at $0.015/result,
searching `"Owner"` in Boise, Idaho: 10 results for $0.15, **867 total matches available**. Returns
full unobfuscated names, real business names inside the headline, correct geography. Returns no email
and no phone (payload grepped: zero email-shaped strings), and `linkedinProfileUrl` is an opaque URN
(`/in/ACoAAASb72gB…`) rather than a vanity slug.

The company-scoped alternative was measured and rejected for this purpose:
`apollo /mixed_people/api_search` is genuinely free per call, but returns `last_name_obfuscated` and
location only as booleans, and against 24 real leads from the live queue produced any person for
10/24, a decision-maker title for 6/24, and **~4/24 usable** — two of the six were a shared corporate
domain (`agents.allstate.com`, returning Allstate HQ staff rather than the local agent) and a
mis-association (`advertisingthatfitz.com` → "Chairman/CEO, Vernon Company"). Coverage collapses
precisely on local SMBs: `larrabeeconstruction.org`, `randrservicesboise.com`,
`boiseconcretecontractor.com`, `idahoselfstorage.com` all returned zero.

### Scope

- **A new source kind** alongside `keyword_geo` and `geo_tiles`: `linkedin_profile_search`, with
  `search`, `locations[]`, `maxItems`, `profileScraperMode`, and `startPage` / `takePages`
  pagination.
- **Budget capped on results, not calls.** `source.budget.max_calls` assumes per-call pricing, which
  is how Google Places bills. harvestapi is `PER_RESULT`. A per-call cap against a per-result price
  is not a budget.
- **A company resolution step** — the mandatory half of this item. Parse the company from the
  headline, then run a Google Places text search on that name plus the person's city, attaching
  `place_id`, `primary_type`, `website`, `address`, `user_rating_count`. Sets `company_resolution`.
  The lane resolves *into* the Places shape, so the shared pipeline needs no changes at all.
- Headline forms to handle, taken from the 10 real profiles already on disk: `Owner at X`,
  `Owner of X`, `Owner / X`, `Owner - X`, `LPC/Owner of X`, `Title | Category` (no company), and bare
  `Owner/Operator` (no company). Eight of ten carry a parseable company name.
- Unparseable or unresolvable becomes `company_resolution = unresolvable`, quarantined, surfaced for
  manual naming — never a stub that enters the pipeline.
- **A head-token confirmation gate on every resolution.** Required, not optional — see the Tier 1
  result below. After Places returns a candidate, take the first distinctive token of the parsed
  company name (stopwords and legal suffixes removed) and require it to appear in the candidate's
  `displayName`. If it does not, the resolution is rejected and the lead becomes `unresolvable`.
  Places text search returns the *nearest plausible* business rather than nothing, so an
  unconfirmed resolution is worse than no resolution.
- **Cross-lane dedupe on `place_id`.** A resolved LinkedIn lead carries the same `place_id` as a
  Places-sourced record for the same business, so it merges deterministically *before* the LLM dedupe
  runs — cheaper and not probabilistic.
- Store the URN. It is a valid **contact** identity key — stable per person, which is what makes
  re-scraping the same profile idempotent rather than duplicative. It must never be a **company**
  identity or dedupe key: it is opaque and not comparable across sources, so company dedupe keys on
  `place_id`.

### Decisions

- **Google Places stays direct**, billed to the GCP account, never routed through Monid.
- Contact data (email, phone) is a separate later enrichment, not part of sourcing.
- The lane's viability rests on the resolution rate and precision, which is unproven — see the
  gating experiment below.

---

## Validation strategy

The governing principle: **every failure this system has produced was success-shaped.** So no check
is allowed to be "it ran and nothing complained." Every check below is a *bite-proof* — a case that
must fail, shown to fail, for the stated reason. Where a check has a bite-proof twin, the twin
disables the mechanism and confirms the case then passes, proving the mechanism was what stopped it
rather than luck.

A second rule, from prior eval work: **an instrument limitation is never a score.** If the harness
cannot observe one of these, it is reported as run-absent, never as a pass.

### Tier 0 — deterministic, $0, all must pass before anything paid runs

**Item 1 — contacts and the invariant**

- Insert a stub company (name only, every other field empty). Assert it is refused by
  `company_resolved_gate` and that the recorded reason names that gate.
- *Bite-proof:* disable `company_resolved_gate` and re-run the same stub. It must then vacuously pass
  `vertical_gate`. This is what proves the invariant neutralized the vacuous-pass hazard rather than
  the stub happening to fail elsewhere.
- Insert a company with three Hunter-shaped contacts. Assert all three attach, exactly one carries
  `is_primary`, and **zero cost events are recorded for the step** — proving the Llama selection call
  is gone rather than merely unused.
- Assert the derived flattened fields (`contact_name`, `contact_title`, `owner_name`) equal the
  primary contact's, so existing gates, briefs, CRM sync, and the review UI still see what they read.

**Item 2 — router**

- Two sequences, no `assign` step → `validate` fails. If this passes, the entire anti-ambiguity
  design is inert.
- Rule targeting an undefined sequence → fails.
- `fallback` naming a sequence with steps → fails.
- Rule reading `score` with `depends_on: []` → fails.
- `dental` ordered before `dental_high` → shadowed-rule warning.
- A fixture of ~20 records with known verticals and scores → each lands in the expected sequence
  **and `routed_by` names the expected rule.** Outcome alone is insufficient: a lead can be routed
  correctly by the wrong rule, which is exactly how the government-office lead came to be filtered by
  `school_gate`.
- A record with `sequence_status = 'active'` → `assign` is a no-op.
- Two sequences defined, sequencer run → each record executes *its own* sequence. **This test must
  fail against today's code**; if it passes before the fix, it is not testing anything.

**Item 3 — sequences as pipeline steps**

- A `wait 2d` step reports not-ready with reason `wake_at`, and becomes ready at T+2d with an
  injected clock. No sleeping.
- A wait landing on a Sunday under `shift_forward` resolves to the expected shifted date.
- A filter between two sends: when the filter fails, send 2 does not execute.
- **The critical pair.** With a completed `send_email` step, clear staleness the way a stuck record is
  repaired today → the send must not re-execute, and the clear must be refused. Then repeat with the
  explicit override → it must re-execute, loudly. Both directions are required; proving only the
  refusal leaves the override untested, and proving only the override leaves the guard untested.

**Item 4 — LinkedIn lane, offline**

- Headline parser fixture built from the 10 real profiles on disk plus hand-added variants: eight
  yield a company string, `Owner/Operator` yields none, `Business Owner | Professional Cleaning
  Service` yields none. The two no-company cases must produce `unresolvable`, not a stub.
- A LinkedIn-resolved record sharing a `place_id` with an existing record merges deterministically,
  and the LLM dedupe is **not** called (assert zero cost events).

### Tier 1 — the gating experiment, run before item 4 is built

The whole lane rests on one unproven assumption: that a company name parsed from a LinkedIn headline
resolves to the right business via Google Places.

- **Input:** the 10 profiles already on disk. Already paid for.
- **Run:** parse company from headline → Places text search on name + the person's city.
- **Measure two things, and weight them unequally.** Resolution rate (how many resolve at all) and
  **precision** (how many resolve to the *correct* business). Precision matters more. A wrong
  resolution attaches some real company's `primary_type`, website, and review count to the wrong
  person, after which every downstream gate evaluates confidently against the wrong entity — a
  poisoned lead that looks perfect and reads as a clean pass.
- **Verification:** all 10 checked by hand against their headlines. The sample is small enough to be
  exhaustive, so there is no sampling error to argue about.
- **Go / no-go:** ≥7/10 resolved *and* ≥9/10 of those resolutions correct. If recall is the problem,
  the lane still works with a larger quarantine. If **precision** is the problem, the lane needs a
  confirmation check — does the resolved site's text contain the person's name — before it is safe at
  any volume.
- **Cost:** ~10 Google Places calls, billed to GCP.

### Tier 1 — result, run 2026-07-30

**Verdict: failed as specified, on precision. The lane proceeds only with the confirmation gate
added to item 4 above.**

Ten real profiles, 8 Google Places calls. Recall: 6/10 resolved. Precision, verified by hand on all
six (the sample is exhaustive, so there is no sampling error):

| Person | Parsed company | Places returned | Correct? |
| --- | --- | --- | --- |
| Dwayne Denison | Denison's Publishing Inc | Denison's Publishing Inc | yes |
| Rebecca Mills | Holding Space Counseling, LLC | **Mind Space Mental Wellness Counseling** | **no** |
| Dave Lakhani | Growth Foundry | **Social Eyes Marketing** | **no** |
| Judi Kieffer | Kieffer Design Group Interior… | Kieffer Design Group | yes |
| Joanne Chauncey | Chauncey & Chauncey Bookkeeping | Chauncey and Chauncey Bookkeeping | yes |
| Sarah M Enright | Innerbloom Dental Studio | Innerbloom Dental Studio | yes |

**4/6 precision against a ≥9/10 bar.** Both failures are the exact poisoning mode the test was built
to catch: Places returned a confident `place_id`, `primary_type`, website, and review count for a
*different business*, which every downstream gate would then have evaluated against. Rebecca Mills
would have carried `primary_type: health`; Dave Lakhani would have carried another marketing agency's
site and reviews. Neither is detectable from the resolution succeeding.

**Token-overlap scoring does not separate them** — the wrong resolution scored 0.67 and a correct one
scored 0.33. The head-token rule does: all four correct resolutions contain the parsed company's head
token in the result, and neither wrong one does. Perfect separation at n=6 — a strong discriminator,
not yet proof, and it needs re-measuring at larger n during Tier 2.

**Recall has a structural ceiling that is not a defect.** Of the four non-resolutions: two carried no
company in the headline at all (`Owner/Operator`; `Business Owner | Professional Cleaning Service`)
and were correctly quarantined. The other two — Affordable Appliance, AVA Media — returned **no
Places hit at all**, verified against both a plain query and a 40km Boise location bias. Those
businesses are simply not in Google Places.

The consequence is a real cost input: **roughly 4 in 10 harvestapi leads cannot enter the pipeline** —
2/10 unparseable, 2/10 absent from Places — because every gate reads Places-shaped fields. That moves
the effective price from $0.015 per result to about $0.025 per usable lead, before counting rejected
mis-resolutions. It also means the quarantine bucket is a first-class review surface, not an edge
case: it is where a tenth of paid-for leads land, each one a real person with a real business that
Google does not know about.

### Tier 2 — end-to-end live run, after all four are built

Run on a **scratch list, not `treasure-valley`**, so nothing touches the 81 leads currently in review.

- Source 25 leads via harvestapi (~$0.375) and 25 via Google Places into the same list.
- Run the full pipeline. Assert:
  - Both lanes reach review and are **structurally indistinguishable** there — same fields
    populated, both carrying a real Google `primary_type`. This is the "unified view of a lead" claim,
    and it is the central thing this whole design asserts.
  - Zero stubs past `company_resolved_gate`.
  - Every LinkedIn-sourced lead has ≥1 contact. Places-sourced leads may have none — that asymmetry
    is intended and should be visible.
  - `vertical_gate` **rejects at least one LinkedIn-sourced lead for a real `primary_type` reason.**
    If the LinkedIn lane never has a lead rejected on vertical, the gate is inert on that lane and the
    run is inconclusive, not a pass.
  - Routing splits into ≥2 sequences, with `routed_by` hand-checked on a sample of 10.
  - The unrouted pen is either non-empty, or provably empty because the rules cover every sourced
    vertical. An empty pen is not evidence of success on its own.
- Then a dry-run sequence execution: assert step ordering and wait dates, and assert **zero outbox
  rows and zero provider calls** — that no send fired in a dry run.

### The acceptance line

The build is validated when all of the following hold, and not before:

1. A LinkedIn-sourced lead and a Maps-sourced lead sit side by side in review, structurally
   identical, both carrying a real Google `primary_type`.
2. No lead reaches review with an unresolved company, and the ones that cannot resolve are visibly
   quarantined with a count.
3. Defining a second sequence without a router is impossible — `validate` refuses.
4. Every routed lead names the rule that routed it.
5. Clearing events to repair a stuck record cannot re-send an email.
6. A re-qualification filter placed between two sends demonstrably blocks the second.

### Cost

| Tier | Spend |
| --- | --- |
| 0 | $0 |
| 1 | ~10 Google Places calls (GCP) |
| 2 | ~$0.375 harvestapi + Places sourcing + model calls on 50 leads |

The Monid balance is $3.87 and needs a top-up before Tier 2.
