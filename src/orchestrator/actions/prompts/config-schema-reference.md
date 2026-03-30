Outbound Config Schema Reference
================================

Top-level shape:

```json
{
  "source": {
    "searches": [<stepConfig>, "..."],
    "filters": [
      {
        "description": "human-readable filter intent",
        "condition": "natural language pass/fail condition",
        "config": <stepConfig>
      }
    ]
  },
  "enrich": [
    {
      "description": "human-readable enrichment intent",
      "config": <stepConfig>
    }
  ],
  "rubric": [
    {
      "description": "natural language criterion",
      "score": 3,
      "config": {
        "columns": ["input_col_a", "input_col_b"],
        "result_column": "rubric_criterion_name"
      }
    }
  ],
  "rubric_config": {
    "score_column": "lead_score",
    "breakdown_column": "lead_score_breakdown",
    "cache": "30d"
  },
  "sequence": {
    "on_reply": "pause",
    "on_bounce": "pause",
    "steps": [
      {
        "action": "any string action type (for example email/dm/call/manual)",
        "day": 0,
        "description": "operator-visible description",
        "template_args": {
          "arg_name": { "from_column": "column_name" }
        },
        "condition": {
          "mode": "only_when",
          "column": "lead_score",
          "check": "equals",
          "value": "true"
        },
        "config": <stepConfig>
      }
    ]
  },
  "data": {
    "destination": "csv|google_sheets",
    "csv": { "path": "@list/prospects.csv" },
    "google_sheets": {
      "sheet_id": "sheet id",
      "worksheet": "Prospects",
      "columns": { "include": ["_row_id", "..."] }
    }
  }
}
```

`stepConfig` shape (generic, passthrough allowed):

```json
{
  "id": "optional_step_id",
  "description": "optional description",
  "args": {
    "query": { "literal": "boise hvac" },
    "domain": { "from_column": "domain" }
  },
  "columns": {
    "output_key_name": "csv_column_name"
  },
  "depends_on": ["source_a", "source_b"],
  "condition": "natural-language boolean check",
  "concurrency": 10,
  "cache": "30d",
  "prompt": "optional step-local guidance",
  "files": {
    "template": "@list/templates/email.md"
  },
  "writes": {
    "passed_column": "source_filter_result"
  },
  "model": "opus|sonnet|haiku",
  "timeout": "3m"
}
```

Search-specific optional fields (inside each `source.searches[]` entry):

```json
{
  "output_fields": ["business_name", "address", "website"],
  "dedup_keys": ["google_place_id", "address"]
}
```

- `output_fields`: instructs execute-step to return discovered rows with those exact keys.
- `dedup_keys`: optional identity columns used by orchestrator to deduplicate repeated search results.
- If required fields are not returned by the initial search tool, add a follow-up filter/enrich step to backfill them (for example by looking up place details from a returned place ID).

Binding formats:

```json
{ "from_column": "column_name" }
{ "literal": "string or number or boolean or null" }
{ "template": "Hi {{first_name}}" }
{ "template_file": "@list/prompts/followup.md" }
{ "file": "@list/prompts/research.md" }
```

Condition object format (sequence step conditions):

```json
{
  "mode": "only_when|skip_when",
  "column": "column_name",
  "check": "equals|not_equals|contains|not_contains|is_empty|not_empty",
  "value": "string"
}
```

Pipeline phases and purpose:
- `source.searches`: discover candidate rows (returns rows).
- `source.filters`: evaluate pass/fail for sourced rows.
- `enrich.*`: populate columns on existing rows.
- `rubric`: score rows using condition checks.
- `sequence.steps`: operator workflow for launch/follow-up.
- `data.destination`: sync final rows to destination systems.

Reserved orchestrator metadata fields (top-level):
- `resolve_dependency_order`
- `resolve_manual_fields`
- `resolve_warnings`

Reserved orchestrator state columns (do not repurpose for step outputs):
- `_row_id`
- `source`, `source_query`, `sourced_at`
- `source_filter_result`, `source_filter_failures`
- `sequence_step`, `sequence_status`, `next_action_date`
- `draft_id`, `draft_status`, `draft_error`, `draft_created_at`
- `sent_at`, `send_status`, `send_error`, `last_outreach_date`

Sourcing provenance rule:
- During `source.searches`, orchestrator always sets `source`, `source_query`, and `sourced_at` from search config/runtime metadata.
- If an execute-step row also returns those keys, orchestrator-managed values take precedence.

Example 1: enrichment source entry

```json
{
  "enrich": [
    {
      "description": "Research company and extract summary",
      "config": {
        "id": "company_profile",
        "args": {
          "company_name": { "from_column": "company_name" },
          "domain": { "from_column": "domain" }
        },
        "columns": {
          "summary": "company_summary",
          "category": "company_category"
        },
        "depends_on": ["domain_resolver"],
        "cache": "14d",
        "concurrency": 5,
        "model": "sonnet",
        "timeout": "4m"
      }
    }
  ]
}
```

Example 2: source filter entry (intent + condition + nested config)

```json
{
  "source": {
    "filters": [
      {
        "description": "Keep rows likely to buy now",
        "condition": "Return true only when the lead is actively evaluating solutions",
        "config": {
          "args": {
            "signals": { "from_column": "buying_signals" }
          },
          "columns": {
            "reason": "buying_signal_reason"
          },
          "writes": {
            "passed_column": "filter_buying_signal_passed"
          },
          "model": "haiku",
          "timeout": "90s"
        }
      }
    ]
  }
}
```

Example 3: rubric (flat array, scored criteria)

```json
{
  "rubric": [
    { "description": "has an email address", "score": 3, "config": { "columns": ["contact_email"], "result_column": "rubric_has_email" } },
    { "description": "has a phone number", "score": 1, "config": { "columns": ["phone"], "result_column": "rubric_has_phone" } },
    { "description": "has at least 10 reviews", "score": 2, "config": { "columns": ["review_count"], "result_column": "rubric_10_reviews" } },
    { "description": "has no email address", "score": -3, "config": { "columns": ["contact_email"], "result_column": "rubric_no_email" } }
  ],
  "rubric_config": {
    "score_column": "lead_score",
    "breakdown_column": "lead_score_breakdown",
    "cache": "30d"
  }
}
```

IMPORTANT: `rubric` is a flat array of criteria, NOT a nested object. Each criterion has `description`, `score` (positive or negative integer), and `config` with `columns` (array of input columns to evaluate) and `result_column` (where to write true/false). The `rubric_config` is a separate top-level key for scoring settings. `max_possible` is computed automatically from positive scores — do not set it manually.

Example 4: sequence step with custom action

```json
{
  "sequence": {
    "steps": [
      {
        "action": "dm",
        "day": 0,
        "description": "Draft initial outreach message",
        "template_args": {
          "first_name": { "from_column": "first_name" },
          "value_prop": { "from_column": "value_prop" }
        },
        "config": {
          "args": {
            "recipient_handle": { "from_column": "social_handle" },
            "message_context": { "from_column": "company_summary" }
          },
          "columns": {
            "draft_preview": "draft_label"
          },
          "model": "opus",
          "timeout": "3m"
        }
      }
    ]
  }
}
```
