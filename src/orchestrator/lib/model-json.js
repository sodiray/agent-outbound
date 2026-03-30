import { z } from 'zod';

const formatIssues = (issues) =>
  issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

const parseWithSchema = ({ jsonText, schema, label }) => {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} JSON parse failed: ${error.message}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label} validation failed: ${formatIssues(result.error.issues)}`);
  }

  return result.data;
};

export const parseModelJsonObject = ({ output, schema, label = 'Model response' }) => {
  const objectMatch = String(output || '').match(/\{[\s\S]*\}/);
  if (!objectMatch) {
    throw new Error(`${label} missing JSON object.`);
  }
  return parseWithSchema({ jsonText: objectMatch[0], schema, label });
};

export const parseModelJsonArray = ({ output, schema, label = 'Model response' }) => {
  const arrayMatch = String(output || '').match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    throw new Error(`${label} missing JSON array.`);
  }
  return parseWithSchema({ jsonText: arrayMatch[0], schema, label });
};

export const zStringish = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])
  .transform((value) => (value == null ? '' : String(value).trim()));

export const zNumberishString = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value) => (value == null || value === '' ? '' : String(value).trim()));

export const zBooleanish = z
  .union([z.boolean(), z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'y'].includes(normalized);
  });
