# External tools and events

Agent Outbound executes the configured graph. A tool node can perform a capability the engine has never heard of through an external command. Inputs and outputs are bound by configuration. Qualification and human review are graph nodes and dependencies chosen by the project, not requirements baked into an integration.

A declared effect receives a stable operation key. The external command owns provider idempotency and reconciliation. The engine records completion independently from delivery outcomes. If the command dies after an external effect, the operation remains uncertain; the graph cannot silently repeat it. An operator can obtain a receipt from the external adapter and reconcile the same operation's declared outputs.

Each `action` node may set `concurrency` to a positive integer. It limits how many record-level invocations of that node run at once; when omitted, the engine uses the conservative default of `4`. The limit does not combine records or change their operation keys, claims, outcomes, or reconciliation behavior.

External pollers and webhook receivers submit normalized events using `events ingest LIST --file FILE`. Each event has a source, id, type, opaque reference, occurrence time and data. Duplicate IDs from the same source are ignored only when their envelopes agree. Conflicting reuse is rejected. Unmatched and ambiguous events remain visible in `events list LIST`; `events resolve` explicitly associates reviewed events with a record.

A configured `await_event` node names an event source/type and a record field containing its reference. It waits durably until the corresponding event exists, maps configured event data to declared outputs and allows downstream graph nodes to execute. The same event can feed explicitly configured consumers without being lost at the first node. Ingestion does not infer commercial intent, pause campaigns or dispatch graph actions by itself. The external polling workflow invokes the normal pipeline runner to continue matched records.

An `on_event` block handles every matching inbound event as a separate turn.
It copies only project-declared payload fields to the record, then runs the
block's ordinary configured steps. A project can classify the inbound message,
ask a reviewer to edit allowed fields, and invoke a configured action without
the engine assigning any conversation or provider meaning. Turns retain their
own history and external-operation identities. A project-selected field check
can stop opening future turns; those matched events remain visible as ignored.

The project chooses how to react: await a response, run a classifier, request human review, invoke a suppression tool, or do something else entirely. For remotely sequenced outreach, the project graph enrolls and waits for events; it contains no competing local send/followup nodes. Provider scheduling, stop-on-reply and suppression semantics belong to the external integration. Local pauses do not imply a remote pause.
