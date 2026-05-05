import { createHash } from 'node:crypto';

const normalizeText = (value: any) => String(value || '').trim();

const pathGet = (obj: any, path: string) => {
  const tokens = String(path || '').split('.').map((item) => item.trim()).filter(Boolean);
  let current = obj;
  for (const token of tokens) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
};

const renderTemplateText = (template: string, vars: Record<string, any>) => {
  let output = String(template || '');
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(vars || {})) {
    const token = `{{${key}}}`;
    if (seen.has(token)) continue;
    seen.add(token);
    const rendered = value === undefined || value === null ? '' : String(value);
    output = output.split(token).join(rendered);
  }
  return output;
};

const chooseVariant = ({ templateRef, recordId }: { templateRef: string | string[]; recordId: string }) => {
  if (!Array.isArray(templateRef)) return String(templateRef || '').trim();
  const ids = templateRef.map((item) => String(item || '').trim()).filter(Boolean);
  if (ids.length === 0) return '';
  const digest = createHash('sha256').update(String(recordId || '')).digest('hex').slice(0, 8);
  const numeric = Number.parseInt(digest, 16);
  const index = Number.isFinite(numeric) ? (numeric % ids.length) : 0;
  return ids[index];
};

export const resolveStepTemplate = ({
  config,
  step,
  record,
}: {
  config: any;
  step: any;
  record: any;
}) => {
  const templateRef = step?.template;
  if (!templateRef) return null;

  const recordId = String(record?._row_id || record?.id || '').trim();
  const templateId = chooseVariant({ templateRef, recordId });
  if (!templateId) return null;
  const templates = config?.templates && typeof config.templates === 'object' ? config.templates : {};
  const template = templates[templateId];
  if (!template) return null;
  const versions = Array.isArray(template?.versions) ? template.versions : [];
  if (versions.length === 0) return null;
  const targetVersion = Number(step?.template_version || 0);
  const selected = targetVersion > 0
    ? versions.find((version: any) => Number(version?.version || 0) === targetVersion)
    : versions.slice().sort((a: any, b: any) => Number(a?.version || 0) - Number(b?.version || 0)).at(-1);
  if (!selected) return null;

  const vars: Record<string, any> = {};
  const declared = selected?.variables && typeof selected.variables === 'object' ? selected.variables : {};
  for (const [name, source] of Object.entries(declared)) {
    const explicit = pathGet(step?.variables || {}, name);
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
      vars[name] = explicit;
      continue;
    }
    if (typeof source === 'string') {
      const direct = pathGet(record, source);
      if (direct !== undefined) {
        vars[name] = direct;
        continue;
      }
      const optionalFrom = normalizeText(source).replace(/^from\s+/i, '');
      const fallback = pathGet(record, optionalFrom);
      if (fallback !== undefined) {
        vars[name] = fallback;
        continue;
      }
    }
    vars[name] = source ?? '';
  }
  for (const [key, value] of Object.entries(step?.variables || {})) {
    if (!(key in vars)) vars[key] = value;
  }

  const renderedSubject = renderTemplateText(String(selected?.subject || ''), vars);
  const renderedBody = renderTemplateText(String(selected?.body || ''), vars);
  const renderedDescription = [renderedSubject ? `Subject: ${renderedSubject}` : '', renderedBody].filter(Boolean).join('\n\n');

  return {
    template_id: templateId,
    template_version: Number(selected?.version || 0),
    subject: renderedSubject,
    body: renderedBody,
    rendered_description: renderedDescription || String(step?.description || ''),
    variables: vars,
  };
};

