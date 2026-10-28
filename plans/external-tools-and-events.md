# External tools and event continuation

## Context and motivation
The engine executes a configured graph. External services own their capabilities, protocols and state. Changing an integration changes the external executable and project configuration, never engine provider code.

## Scope
Reuse command tools, input/output bindings, author-declared effects and idempotency. Add generic operation context/receipts and durable event ingress with a configured await-event graph node. Add CLI and operator review surfaces; preserve existing native capabilities. Mission tooling owns the provider adapter, campaign routing, polling, suppression translation and recovery journal.

## Phases
- [x] Phase 0: replace vendor-specific docs with docs/product/external-tools.md and docs/technical/external-tools.md; update technical integrations. Mission operational contract lives in utilities/outbound-tools/README.md; no Mission product or architecture changes.
- [x] Extend existing operation identity into external commands and reconcile opaque successful receipts.
- [x] Add durable normalized event ingress/correlation and await-event graph execution.
- [x] Implement external provider adapter and a materially different deterministic adapter in Mission tooling, with configuration examples.
- [x] Prove portability, crash/retry behavior, graph progression and validation in both repositories.

## Decisions
Use a first-class action node, not an enrichment-stage workaround; reuse existing author idempotency; completed internal idempotency status is not evidence of an email send. Unknown effects are not re-executed automatically. Commands receive an opaque stable operation key through their environment; external tools persist/reconcile it. Generic successful receipts restore declared outputs and complete the operation. Events contain source/id/type/reference/time/data; the engine interprets only configured bindings. Qualification, review and subsequent handling are graph decisions. No provider-specific dispatch exceptions or email-ownership switches exist in the engine. No live sending, enrollment or paid sourcing is part of implementation.

Validation: pinned Node 24 `yarn test` passes all 1,182 tests. Mission outbound-tools has 9 passing targeted tests, including the two-executable real CLI portability proof. Existing author-step batching is unchanged; only first-class actions receive per-record operation context. Source/test audit contains no provider-specific integration references. No live provider or model calls were made. Mission repository-wide checks are explicitly excluded by the user; no dependency repair is required.
