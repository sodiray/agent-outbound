export const readUsageSnapshot = ({ db, since = '' as string }) => {
  const where = since ? 'WHERE occurred_at >= ?' : '';
  const params = since ? [since] : [];
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(usd_cost), 0) AS usd_cost
    FROM cost_events
    ${where}
  `).get(...params);
  const toolRows = db.prepare(`
    SELECT
      UPPER(CAST(j.value AS TEXT)) AS tool,
      COUNT(*) AS calls
    FROM cost_events ce
    JOIN json_each(CASE WHEN json_valid(ce.tool_calls) THEN ce.tool_calls ELSE '[]' END) j
    ${where ? `${where}` : ''}
    GROUP BY tool
  `).all(...params);
  const tools: Record<string, number> = {};
  for (const row of toolRows) {
    const key = String(row?.tool || '').trim();
    if (!key) continue;
    tools[key] = Number(row?.calls || 0);
  }
  return {
    llm: {
      input_tokens: Number(totals?.input_tokens || 0),
      output_tokens: Number(totals?.output_tokens || 0),
      usd_cost: Number(totals?.usd_cost || 0),
    },
    tools,
  };
};

export const diffUsageSnapshot = ({ before, after }: { before: any; after: any }) => {
  const toolKeys = new Set([
    ...Object.keys(before?.tools || {}),
    ...Object.keys(after?.tools || {}),
  ]);
  const toolDelta: Record<string, number> = {};
  for (const key of [...toolKeys].sort()) {
    const delta = Number((after?.tools || {})[key] || 0) - Number((before?.tools || {})[key] || 0);
    if (delta !== 0) toolDelta[key] = delta;
  }
  return {
    llm: {
      input_tokens: Number(after?.llm?.input_tokens || 0) - Number(before?.llm?.input_tokens || 0),
      output_tokens: Number(after?.llm?.output_tokens || 0) - Number(before?.llm?.output_tokens || 0),
      usd_cost: Number(after?.llm?.usd_cost || 0) - Number(before?.llm?.usd_cost || 0),
    },
    tools: toolDelta,
  };
};

export const scaleUsageProjection = ({ delta, multiplier }: { delta: any; multiplier: number }) => {
  const factor = Number.isFinite(Number(multiplier)) && Number(multiplier) > 0 ? Number(multiplier) : 1;
  const projectedTools: Record<string, number> = {};
  for (const [tool, calls] of Object.entries(delta?.tools || {})) {
    projectedTools[tool] = Math.round(Number(calls || 0) * factor);
  }
  return {
    llm: {
      input_tokens: Math.round(Number(delta?.llm?.input_tokens || 0) * factor),
      output_tokens: Math.round(Number(delta?.llm?.output_tokens || 0) * factor),
      usd_cost: Number((Number(delta?.llm?.usd_cost || 0) * factor).toFixed(6)),
    },
    tools: projectedTools,
    multiplier: factor,
  };
};

