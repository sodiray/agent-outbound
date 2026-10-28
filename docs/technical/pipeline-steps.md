# Pipeline Step Capabilities

## Re-runs, changed gates, and skipped dependencies

Pipeline treats a paid or side-effecting tool call as resolved once it has a settled outcome. A later edit to its definition does not replay that call merely because the YAML changed. Its replay key is the resolved arguments actually sent to the tool: changing an `args_map` source with the same resolved value remains fresh, while changing a resolved argument replays that record. This applies to `data_enrichment`, `external_mutation`, `human_contact`, and a priced `data_lookup` tool effect. Set `rerun: true` on an enrich step or run `pipeline <list> --rerun-step ID` to deliberately replay it. `pipeline --dry-run` reports the resulting `would_enrich` count before any call is made.

## Deferred generic actions

A command tool for a generic `kind: action` may attest that it did not execute by exiting 0 and printing exactly this JSON object on stdout: `{"ao_outcome":"deferred","reason":"<short text>","retry_after":"<optional ISO-8601 timestamp>"}`. `ao_outcome` is reserved for AO control outcomes and is never an action output or record field. `reason` is required; `retry_after` is optional. No keys besides these three are allowed in a deferred result.

AO releases the action's idempotency claim, writes no declared outputs, leaves the step pending, and does not run dependents. When `retry_after` is present, AO does not invoke the tool again before that time. Deferred is visible as a deferred step state and makes the run incomplete, not errored. A non-zero exit, thrown error, malformed deferred object, unknown `ao_outcome`, or deferred object with any output remains an uncertain side-effect outcome and requires reconciliation.

Filters and exits retain a per-record definition and input fingerprint. When a gate changes, records it previously dropped under that gate return to the next pipeline run unless a human override or review decision applies. A passing re-evaluation clears the automatic rejection without creating a keep override; a continuing failure records the new gate verdict. Human keep/drop overrides and review decisions remain authoritative.

A gate waits when one of its declared upstream steps was skipped by `when:` or has not completed. It does not treat a missing value from a skipped verification or enrichment step as a failed condition. The next run evaluates the gate after its prerequisite runs.

## Parked reviews and pipeline changes

A pending review is a pause for its downstream work, not a snapshot of the
pipeline. When a pipeline change adds or materially changes a non-terminal
step upstream of that review, the next run evaluates that step for the parked
record before returning it to the review. Newly produced fields are then
available through the review's configured `fields` and presentation.

An approved or rejected pipeline review remains a human override. It is not
reopened merely because the pipeline definition changes, and upstream paid or
side-effecting work never replays when its resolved arguments are unchanged.
The existing version-bound stage-review rule is separate: authorization for an
external action becomes stale when its material asset version changes
(account/contact, recipient, content or claim, or step identity), and the
record is paused for a new review. `pipeline --dry-run` uses the same
eligibility rules as a real run, so its per-step counts include work released
ahead of a pending review.

## LLM sampling

LLM-backed pipeline steps accept an optional `temperature` from `0` through
`2`. It overrides the role default for that step:

```yaml
- kind: enrich
  id: condense_evidence
  model: openrouter/openai/gpt-4.1-mini
  temperature: 0
```

Evaluation and research roles use `temperature: 0` when their model supports
it; copywriting otherwise uses the provider default. A step-level value wins
over that role default. OpenRouter capabilities come from the locally cached
model inventory. Agent-Outbound sends a temperature only when that inventory
knows the selected OpenRouter model supports it. `config validate` rejects a
step-level temperature for a known unsupported model; unknown capability data
omits the parameter and is visible with `AO_DEBUG_LLM=1`. Refresh the inventory
with `agent-outbound models refresh` after OpenRouter changes a model.

Sampling is part of an LLM step definition. Changing `temperature` therefore
makes ordinary memoized/free LLM work stale just as another material definition
change does. It does not replay a settled paid or side-effecting tool call;
those retain their resolved-argument replay rules above.

## Typed decisions

A `decide` step asks one or more typed questions about a record. Agent-Outbound
uses Jev as its built-in decision backend. A decision stays generic: it sends a
selected record state and question definitions, then writes typed answers and
confidence values. It has no outbound-, email-, or vertical-specific behavior.

Enable it only in projects that contain a `decide` step:

```yaml
ai:
  decide:
    model: jev-1.13.0
    api_key_env: JEV_API_KEY # optional; this is the default
```

`model` is required when a project has any `decide` step. The API key is read
from the configured environment variable at validation and run time; the key is
never stored in project config. `config validate` fails before a run if the
model is missing or the configured variable is unset. Projects without a
`decide` step do not require a Jev key. `JEV_BASE_URL` may override the API
base URL, which is useful for local test servers.

```yaml
- kind: decide
  id: mep_fit
  depends_on: [source_has_email]
  state: [title, company]
  context: We sell takeoff automation to commercial MEP subcontractors.
  concurrency: 8
  questions:
    company_type:
      type: choice
      instructions: What kind of organization employs this person?
      options:
        mep_subcontractor: Installs electrical, mechanical/HVAC, plumbing or fire protection work.
        general_contractor: A general contractor or construction manager.
        other: Anything else.
    fit_score:
      type: score
      instructions: How well does this company match a commercial MEP subcontractor?
      levels:
        - Not a match.
        - Possible match.
        - Strong match.
    is_estimator:
      type: yes_no
      instructions: This person prepares or leads bids and estimates.
    stage:
      type: choice
      instructions: Which stage applies now?
      options_file: ../shared/stages.yaml
      option_text: applies_when
```

`state` names the record fields sent as Jev state. `context`, when present, is
sent as `state.context`. A `choice` question sends its `options` as Jev
criteria. A `score` question sends `levels` in Jev's Score primitive shape. A
`yes_no` question maps to Jev's Noul primitive. `options_file` is a YAML map
resolved relative to the project directory; `option_text` selects the value in
each option object used as its criteria.

Each record gets one request for all questions in the step. Successful answers
declare and write these fields, so later steps, `when:` predicates, filters,
and reviews can use them:

- `choice`: `<question>`, `<question>_confidence`, and `<question>_probabilities`.
- `score`: `<question>`, `<question>_confidence`, and `<question>_probabilities`.
- `yes_no`: `<question>` as a number from 0 through 1.
- An `options_file` choice also writes each other property from its selected
  option as `<question>_<property>`; for example `stage_guidance`.

The complete Jev request and response are retained in the step result/audit
trail. Reported input and output tokens appear in AI usage. Network failures,
timeouts, non-success responses, and malformed or incomplete answers write no
decision and follow the step's `on_error` behavior (default `fail`), leaving a
record retryable. Successful decisions are memoized and become stale when the
model, question definitions (including the resolved option file), context, or
selected state values change.

### Confidence triage

Confidence lets a pipeline automate clear results while holding ambiguity for a
person. For example, drop only a confident misfit, then park only uncertain
remaining records for review:

```yaml
- kind: filter
  id: reject_confident_misfit
  depends_on: [mep_fit]
  when: company_type == "other" && company_type_confidence >= 0.8
  type: field_check
  conditions:
    - field: company_type
      operator: neq
      value: other

- kind: review
  id: review_uncertain_fit
  depends_on: [mep_fit]
  when: company_type_confidence < 0.8
  fields: [company, title, company_type, company_type_confidence]
```

## Editable review fields

A review stage can restrict which record fields a reviewer may edit before
approval:

```yaml
- kind: review
  id: correct_company
  fields: [company, company_type]
  edit_fields: [company, company_type]
```

Approve with one or more `--set field=value` flags:

```
agent-outbound review approve my-list rec_123 --stage correct_company --set company="Acme Mechanical" --set company_type=mep_subcontractor
```

Only fields listed in `edit_fields` can be changed. Edited values are saved to
the record before approval and retained in the review audit.

## Event turns

An `on_event` block runs its inner graph once for each matching inbound event.
It is a generic record-state loop: the block names an event source, type, and
reference field, while the project defines the meaning of the message and the
fields that end the loop. A block is active after its outer dependencies pass.

```yaml
- kind: on_event
  id: inbound_turn
  depends_on: [ready_for_messages]
  source: message_gateway
  event: inbound_message
  reference_field: conversation_ref
  event_fields:
    inbound_text: text
    inbound_message_id: message_id
  until:
    conditions:
      - field: conversation_stage
        operator: in
        value: [finished, stopped]
  on_new_event: supersede
  steps:
    - kind: decide
      id: understand_message
      state: [inbound_text]
      questions:
        next_stage:
          type: choice
          instructions: Choose the appropriate conversation state.
          options: {active: Continue, finished: No more messages are needed}
    - kind: review
      id: check_response
      depends_on: [understand_message]
      fields: [inbound_text, next_stage]
      edit_fields: [next_stage]
    - kind: action
      id: send_message
      depends_on: [check_response]
      side_effecting: true
      idempotency: {key_source: [inbound_message_id], scope: list}
      tool: {name: send_configured_message}
      args_map: {text: inbound_text}
```

When a turn opens, `event_fields` are copied from the event payload to the
record before the inner steps run. Inner `depends_on` values refer only to
sibling inner ids. Each turn keeps separate step completion, review, output,
memoization, and action-operation state; record fields contain the latest
outputs while turn history retains prior outputs. Nested `on_event` blocks and
`await_event` inside a block are invalid.

There is one open turn for a record and block. `supersede` marks an open turn
superseded when a newer event arrives, leaving already-recorded effects intact
and preventing its remaining steps from running. `queue` waits for the open
turn to complete. Before a turn opens, `until.conditions` is evaluated against
the record; a matching event after it passes is retained as an ignored turn.
Action operation keys include the turn identity, in addition to declared
idempotency inputs, so separate turns cannot share an external operation.

## Contact sources

A `contact_source` step promotes the email in `field` to a pipeline-supplied contact. It can also optionally declare `name_field` and `title_field` to copy authored record values into that contact:

```yaml
- kind: contact_source
  id: promote_contact
  field: contact_email_value
  name_field: contact_name_value
  title_field: contact_title_value
  role: primary
```

`name_field` and `title_field` are optional. Blank or missing values do not overwrite values already stored on a pipeline-supplied contact. A contact source never changes a matching contact whose source is not `pipeline`.

The values are stored as authored. Name processing is left to the pipeline author; the normal contact projection then derives `contact_first_name` for templates from the stored full name.

## Field-to-field checks

`field_check` conditions compare against a literal with `value`, a membership list with `value_file`, or another record field with `value_field`. These forms are mutually exclusive.

```yaml
- kind: filter
  id: verify_quote
  type: field_check
  inputs: [source_text, quoted_text]
  conditions:
    - field: source_text
      operator: contains
      value_field: quoted_text
```

`value_field` is supported by `contains`, `eq`, `neq`, `gt`, `gte`, `lt`, and `lte`. The referenced field must be declared in the step's inputs and must be supplied by a source or a pipeline producer; an unresolved reference is a validation error. A missing, null, or blank referenced value fails the condition rather than comparing as an empty string.

Literal `value` is never interpolated. For example, `value: "{other_field}"` remains exactly that literal value; use `value_field: other_field` for a field comparison.
