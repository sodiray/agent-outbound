# Side effects and guarantees

Date: 2026-08-09. Aligned with the owner before any code was written.

This document describes the **end state**: what Agent Outbound promises, what it refuses to
promise, and how a person reads a lead and knows which is which. The work list at the bottom
is deliberately short — the design is the point.

---

## The one idea

**Agent Outbound guarantees what it owns end to end, offers mechanism everywhere else, and
never blurs the two.**

A pipeline can do anything. An author can write a stage that purchases a gift card, files a
permit, or wires money, using a tool the engine has never heard of. The engine cannot inspect
that stage, cannot verify what it did in the world, and cannot undo it. Pretending otherwise
is the failure mode this design exists to prevent — a promise the engine cannot keep is worse
than no promise, because it stops people from looking.

So the line is drawn where the engine's knowledge actually ends:

| | Agent Outbound owns | Author owns |
|---|---|---|
| **What it is** | Steps where the engine renders the artifact **and** performs the transmission — `send_email`, `send_sms`, `linkedin_connect` | Any stage an author builds that reaches the world through a tool the engine merely invokes |
| **What the engine promises** | The message a human approved is the message that is sent. Verifiable, enforced. | Nothing about the outcome. |
| **What the engine provides** | The guarantee | Vocabulary to declare intent, an approval queue, idempotency, and an honest record of what was invoked |

Everything below follows from that table.

---

## 1. Guaranteed: approved content is sent content

**Invariant.** A human approves a specific message. Only that message can be sent.

Today a draft is a snapshot. It is rendered, queued for a human, and never reconsidered. Any
later change to what the message would say — a template edit, a different model, better
enrichment, a compliance fix — updates the record and the config and never touches the queued
copy. Approval sends the copy.

In the end state:

- A draft records a hash of its **rendered content**, plus the template id and version it came
  from.
- At the moment of sending, the message is re-rendered and compared. Identical: send.
  Different: **do not send** — supersede the draft, queue a fresh one, and record why.
- Listing pending approvals performs the same comparison, so divergence is visible in the queue
  rather than only at the moment it blocks a send.

### Why the hash is of the output, not the inputs

The engine already tracks staleness by dependency hash, per record per step. Reusing that here
would be wrong. A pipeline built on invalidation recomputes constantly by design; keying
approvals to `dep_hash` would invalidate them every time an unrelated upstream field refreshed,
and a queue that re-asks for approval on every recompute trains people to click through it.

Hashing the rendered artifact means the model may re-run, the scrape may refresh, the score may
move — and if the resulting text is byte-identical, the approval stands. **Only a change in what
the recipient would actually read breaks it**, which is precisely what the human was approving,
and it makes the reason legible: the message changed.

### Scope is the point

This invariant is claimed **only** where the engine holds both ends — it rendered the artifact
and it operates the transmitter. It rests on no author assertion. It must not be described, in
documentation or in the UI, as a general property of side-effecting steps.

---

## 2. Mechanism without promises: author-built stages

The engine cannot know which stages touch the world. Today it does not even let an author say so.

`side_effecting: true` is required — via `z.literal(true)` — on exactly three kinds:
`send_email`, `send_sms`, `linkedin_connect`. `manual_task` accepts it but defaults to `false`.
Every other kind rejects the key outright. Adding `side_effecting: true` to a real `enrich` step
that calls an external service produces `Unknown config key "pipeline[9].side_effecting" is not
recognized.` The same is true of `draft_approval_required`, which lives in the same block: an
author-built stage cannot request human approval, and cannot enter the approval queue at all.

Approval is currently a privilege of the step kinds the engine happens to implement. For a tool
meant to be published and used by other teams, that is the defect — a pipeline author who writes
a stage that spends money has no way to gate it behind a human.

In the end state:

- **Any step kind may declare `side_effecting`.** It is an author's assertion about the world.
  The engine records it, surfaces it, and reasons with it — and never treats it as verified.
- **Any step kind may declare `draft_approval_required` and enter the approval queue.** Approval
  is a property of a step, not of a step kind.
- **`manual_task` defaults `side_effecting` to `true`.** A task handed to a human to perform is
  world-touching by definition; defaulting it to `false` is backwards.
- **Idempotency remains the re-execution control** for author-built effects. Once a gift card is
  purchased, staleness is moot — the only meaningful protections are *don't do it twice* and
  *let a human approve before it happens*, and today authors have the first and not the second.

**Explicit non-goal.** The engine does not attempt to detect, infer, or audit side effects. An
unlabelled stage is outside every guarantee here, and that is a stated property rather than a
gap to be closed.

---

## 3. Observable: a lead's state is legible

Someone reading a lead must be able to tell, without querying the database, what happened, what
is merely planned, and which facts the engine can actually vouch for.

The timeline already separates `score` events from `channel` events, and `pipeline_events`
already carries `side_effecting` per row, so most of the data exists. What is missing is that
the presentation conflates categories that must never be confused.

- **Tense.** Every entry states whether it *occurred* or is *planned*. A future-dated entry may
  never carry a success disposition. Today a suppressed, opted-out lead displays
  `2026-08-15 | channel | executed | email | ok` — a send that has not happened, on a person who
  asked us to stop, rendered identically to history. Nothing will actually send; suppression
  holds. The record simply says something false.
- **Reconciliation.** Projections derive from current state. A lead who opted out has no plan.
- **Provenance.** Every external entry says which side of the boundary it is on: *performed and
  evidenced* — the engine holds the provider message id, the bounce, the reply — or *dispatched
  and unverified*, where the engine knows only that it invoked something.
- **Abandoned state is visible.** Removing a step leaves its outputs and staleness rows behind;
  a record can hold a field no step in the current pipeline produces, and look current. At
  minimum, config validation warns when a step reads a field nothing produces.

---

## What this design refuses

- **No `on_content_change: revoke | flag | ignore` knob.** The only safe value is "do not send";
  a setting whose alternatives are unsafe is a footgun with a config key.
- **No auto-revoke on input change.** Content recomputes by design; this would thrash the queue.
- **No general side-effect framework** predicated on a label the engine cannot verify.
- **No rollback of external effects.** The engine does not pretend the world is transactional.

---

## Why this design

Every element above is a measured failure, not a hypothetical.

- **19 of 25 pending drafts were stale**, holding output from a composer that had been deleted
  from the config, each one approval-click away from a real business.
- **9 of those 25 carried no opt-out line** — added the day before as a compliance fix, verified
  in the parsed config, and never reaching the queue. Recorded as fixed while five approvable
  drafts lacked it. No migration was involved; an ordinary improvement did this.
- **A real `enrich` step calling an external service cannot declare itself side-effecting.**
- **An opted-out lead shows two future sends as `executed | ok`.**

The shape is the same one this codebase keeps producing: a fact with two homes and only one of
them updated. What is new is that in the draft queue, the stale copy is the one pointed at a
person.

---

## Work to get there

1. **Send-time content equivalence.** Draft records a rendered-content hash and its template
   id/version; the send path re-renders, compares, and refuses on divergence, superseding and
   re-queuing. Scoped to steps where the engine owns rendering and transmission.
2. **Divergence visible in the queue**, using the same comparison as (1).
3. **Side-effect and approval vocabulary generalized.** `side_effecting` and
   `draft_approval_required` declarable on any step kind; `manual_task` defaults to
   `side_effecting: true`.
4. **Timeline tense, reconciliation, and provenance**, per section 3.
5. **Abandoned-state visibility** — validation warns when a step reads a field no step produces.

Items 1 and 2 are one change. Item 3 is independent and is the one that makes the engine
publishable. Items 4 and 5 are legibility and can follow.

---

## As shipped

All five landed on 2026-08-09, each with its failing test demonstrated before the fix.

| | | commit |
|---|---|---|
| 1–2 | Approved content is sent content | `3234b70` |
| 3 | Any step may declare a side effect and require approval | `ce6c81a` |
| 4 | Timeline tense, reconciliation, provenance | `99216ab` |
| 5 | Warn when a step reads a field nothing produces | `4944530` |

Two things were found while building and are worth carrying forward.

**Item 4 turned up a second false-fact path** nobody was looking for: generic sequence actions
fabricated a random provider id when none came back, making an unverified action look evidenced.
Removed — engine-owned sends now require real provider evidence, and historically ambiguous rows
are presented as unverified rather than promoted to proven.

**Item 5 earned itself immediately**, flagging a step that read `decision_maker_name` when the
producing step writes `decision_maker_discovery_*`. Worth recording how that repaired: the first
fix pointed the step at the discovery field and was wrong — measured across 365 records,
`decision_maker_discovery_name` is populated 0 times, the legacy field 8, and
`decision_maker_reveal_name` 10, so the fix traded 8 values for none. A warning tells you a
declaration is wrong; it does not tell you the replacement is right.

## Still open

**Idempotency does not reach author-built side effects.** This plan named it as the re-execution
control for author-declared stages. It is not: the schema rejects `idempotency` for enrich steps,
so a stage that spends money now gets human approval and no duplicate-execution protection.
Nothing was faked to paper over this — implying protection that does not exist is the same false
promise the design exists to remove — but the gap is real and the plan was wrong to assume
otherwise. It is the next piece of work.

**The item 5 warning is noisier than it should be.** On a healthy, fully-valid config it produces
13 warnings, all of them engine-written columns (`enrichment_cost_usd`, `duplicate_reason`,
`invite_message`, the `policy_apply` confidence family) that the exemption list does not cover.
A check people learn to ignore is worse than no check — this codebase already has one case where
ignored warnings let three unenforced safety declarations reach a live pipeline.
