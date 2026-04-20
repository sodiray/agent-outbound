# Visits

Visit handling is capability-driven and tool-agnostic.

## Triggering

A sequence step is classified as visit-related from its natural language description. Visit steps are batched for route planning before execution.

## Configuration

Route planning tools are declared in:

```yaml
channels:
  visit:
    tool:
      toolkits: [YOUR_ROUTING_TOOLKIT]
      tools: []
```

No router lookup table exists in product code. The configured toolkit is used directly.

## Execution Rules

1. Due visit steps are collected.
2. The runner requires `channels.visit.tool` to be present.
3. Toolkit availability is checked against connected Composio toolkits.
4. `plan-route` runs with the pinned tool spec.
5. Routes and route stops are persisted.
6. Visit steps execute with route context.

If configured visit toolkits are missing at runtime, execution fails with a clear reconnect/update-config error.
