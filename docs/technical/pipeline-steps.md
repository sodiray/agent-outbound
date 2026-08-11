# Pipeline Step Capabilities

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
