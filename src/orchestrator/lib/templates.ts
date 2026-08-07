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

const isBlank = (value: unknown) => (
  value === undefined || value === null || String(value).trim() === ''
);

/**
 * Render {{token}} and {{token | default: value}} / {{token | default: "value"}}
 * against a vars map. Unknown tokens with no default become empty string.
 */
export const renderTemplateText = (template: string, vars: Record<string, any>) => {
  let output = String(template || '');
  // Support: {{ key }}, {{ key | default: bare }}, {{ key | default: "quoted" }}, {{ key | default: 'quoted' }}
  output = output.replace(
    /\{\{\s*([A-Za-z_][\w.]*)\s*(?:\|\s*default\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))\s*)?\}\}/g,
    (_match, key: string, dDouble?: string, dSingle?: string, dBare?: string) => {
      const fallback = dDouble ?? dSingle ?? dBare ?? '';
      const raw = pathGet(vars, key);
      if (isBlank(raw)) return fallback;
      return String(raw);
    },
  );
  return output;
};

/** Collect placeholder keys referenced in a template string. */
export const collectTemplateKeys = (template: string): string[] => {
  const keys = new Set<string>();
  const re = /\{\{\s*([A-Za-z_][\w.]*)\s*(?:\|[^}]*)?\}\}/g;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(String(template || ''))) !== null) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys];
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

/** Common outbound fields bound from the record when not declared on the template. */
const AUTO_RECORD_FIELDS = [
  'business_name',
  'name',
  'contact_name',
  'contact_first_name',
  'contact_email',
  'contact_title',
  'contact_name_primary',
  'owner_name',
  'decision_maker_name',
  'address',
  'city',
  'state',
  'phone',
  'website',
  'domain',
];

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

  // Auto-bind record fields for any placeholder used in subject/body.
  const usedKeys = collectTemplateKeys(`${selected?.subject || ''}\n${selected?.body || ''}`);
  for (const key of [...AUTO_RECORD_FIELDS, ...usedKeys]) {
    if (key in vars && !isBlank(vars[key])) continue;
    const fromRecord = pathGet(record, key);
    if (fromRecord !== undefined && fromRecord !== null) {
      vars[key] = fromRecord;
    } else if (!(key in vars)) {
      vars[key] = '';
    }
  }
  // Prefer a human-readable contact name for {{contact_name}} when empty.
  if (isBlank(vars.contact_name)) {
    vars.contact_name = pathGet(record, 'contact_name_primary')
      || pathGet(record, 'decision_maker_name')
      || pathGet(record, 'owner_name')
      || '';
  }
  if (isBlank(vars.business_name)) {
    vars.business_name = pathGet(record, 'business_name') || pathGet(record, 'name') || '';
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
