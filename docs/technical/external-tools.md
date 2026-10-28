# Configured external tools

The first-class `action` node reuses the existing command-provider registry and tool invocation/output bindings. It bypasses enrichment memoization, requires explicit side effects and idempotency, and exposes no native provider selector. Per-record operation context applies only to action nodes; existing step kinds retain their batching behavior. Configuration owns tool names, argument bindings, output paths, declared effects and review dependencies. No provider is selected by a native engine switch.

Action nodes and existing author-declared idempotent steps reuse the existing durable claims. External commands receive `AO_OPERATION_KEY`, `AO_RECORD_ID` and `AO_STEP_ID` in their environment. The operation key is opaque and stable across process failure. `operations list` exposes pending/uncertain operations; `operations reconcile LIST --file RECEIPT` applies a successful adapter receipt (`operation_key`, `status: succeeded`, `outputs`) to that exact step/record. Unknown receipts leave the operation blocked. A receipt is trusted operator input, not a claim of exactly-once behavior in the provider. Declared output validation and transactional persistence apply before reconciliation completes.

An `action` node accepts `concurrency: <positive integer>` and defaults to `4`. The runner applies that bound to record-level external invocations after their individual operation claims are made. Each invocation retains its own operation key and uncertain-outcome behavior, including when a process stops while other bounded work is in flight.

`external_events` stores normalized envelopes keyed by source and id. Ingress deduplicates exact replays, rejects conflicting reuse, and correlates references only through configured await-event nodes. No email address or provider payload is guessed. Zero matches are unmatched; multiple records are ambiguous. Explicit resolutions preserve the original envelope and record their timestamp. Retry re-correlates pending unmatched events as graph outputs become available.

The generic node contract is:

```yaml
kind: await_event
id: wait_for_response
source: outreach
event: response_received
reference_field: enrollment_ref
inputs: [enrollment_ref]
output_map:
  response_text: text
outputs:
  response_text: {type: string, description: Response content}
```

The node consumes configured data paths, validates declared outputs, writes them to record state and records consumption atomically. Separate consumption identities allow configured fanout. A crash after consumption but before a pipeline pass replays stored outputs without fetching or dispatching anything. The normal graph runner controls continuation. `events list` and configured event-review pending rules expose unmatched/ambiguous events. Provider polling cadence, pagination, overlapping windows and provider IDs are entirely outside the engine.

`on_event` is the repeatable counterpart to `await_event`. It matches the same
normalized envelopes but creates one durable turn per matching event. The
turn's configured payload paths are written to record fields before its inner
steps execute. Events are ordered by occurrence time and id. An open turn is
either superseded by a newer event or held ahead of it according to
`on_new_event`; a configured field-check `until` marks later events ignored.
`turns LIST` exposes the event, turn status, and inner-step outcomes.
For a turn review, `review approve LIST RECORD --stage INNER_REVIEW_ID` and
`review reject LIST RECORD --stage INNER_REVIEW_ID` use the review step's raw
inner `id`, not its turn-scoped runtime id.

Tests use independent external command adapters with different request/result semantics against the same engine and vary only project bindings. No live service or model call is required for portability proof. `yarn test` is the build-and-test composite under the pinned Node version.
