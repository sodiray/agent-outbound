# Viewer

Open a list in the local viewer with:

```sh
agent-outbound view <list>
```

The command serves the viewer locally and opens it in a browser. Use `--port 7788` to choose a port, `--no-open` to leave the browser closed, or `--build` to rebuild the viewer bundle first.

## Routes

- **Table (`/`)** shows the list as a sortable, filterable record table. Select a record to open its detail panel.
- **Pipeline (`/pipeline`)** shows the list pipeline as a live, top-down canvas. Sources are at the top; dependencies form branches and joins; a conditional step displays its `when` predicate; and `on_event` turn steps appear in a labelled **per event** group below their parent.
- **Map (`/map`)** shows records geographically.
- **Review (`/review`)** is where review happens: one tab per review stage, each with its queue of records awaiting a decision. `/review?stage=<stage_id>` opens with that stage's tab active, and switching tabs updates the URL.
- **Sequences (`/sequences`)**, **Manual (`/manual`)**, and **Rejected (`/rejected`)** show their respective operational queues.

## Pipeline canvas

Every pipeline step is a node. Node styling distinguishes source, enrich or tool call, filter, structured AI decision, human review, action, and wait or `await_event`. A node shows its id, label, and tool or model where configured.

The canvas derives edges from declared `depends_on` and inferred dataflow dependencies, so independent paths fan out and dependent paths converge. Layout is automatic, fit to the viewport when opened, and supports pan and zoom; operators do not position nodes.

Nodes show live record counts: waiting or in progress, passed, dropped at that step, and skipped because `when` did not match. A node also shows recorded spend when it has any. The running node displays activity. Counts update while the page is open.

Review nodes show the number awaiting a decision and stand out when that count is nonzero, making pending human work visible in the context of the entire pipeline.

## Step panels

Select any node to open the standard right-side panel over the canvas. It has the same width, slide-out behavior, and styling as record detail. Click the canvas scrim or press `Esc` to close it.

For every step, the panel shows its definition—kind, tool or model, inputs, outputs, `depends_on`, and `when`—along with its counts.

For a non-review step, its record list switches between waiting, passed, and dropped records. Selecting a record opens the normal record detail.

For a top-level review step, the panel shows how many records await a decision and a **Review Leads** button carrying that count (for example, "Review Leads · 769"). The button opens the Review page with that stage's tab already active (`/review?stage=<stage_id>`). The pipeline page shows no review queue itself: everything about review lives on the Review page, and everything about the pipeline and its steps lives on the Pipeline page.

A review step inside a **per event** group has no Review page tab; its panel is read-only, and those turns are decided with `agent-outbound review approve|reject`.

## Keyboard map

- `Esc` closes the open panel.

The selected step and record are carried in the URL, for example `/pipeline?step=quality_gate&record=row_42`. Reloading or sharing that link restores the same canvas selection and panel.
