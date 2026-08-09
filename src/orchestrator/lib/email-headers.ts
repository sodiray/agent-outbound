const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const REFUSED_EXACT_NAMES = new Set([
  'apparently-to',
  'authentication-results',
  'bcc',
  'cc',
  'content-length',
  'content-transfer-encoding',
  'content-type',
  'date',
  'delivered-to',
  'delivery-date',
  'dkim-signature',
  'domainkey-signature',
  'from',
  'in-reply-to',
  'message-id',
  'mime-version',
  'received',
  'received-spf',
  'references',
  'reply-to',
  'return-path',
  'sender',
  'to',
  'x-google-dkim-signature',
]);

const refusedName = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return REFUSED_EXACT_NAMES.has(normalized)
    || normalized.startsWith('arc-')
    || normalized.startsWith('resent-');
};

const valueAtPath = (source: Record<string, unknown>, path: string): unknown => (
  path.split('.').filter(Boolean).reduce<unknown>((current, segment) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), source)
);

export const emailHeaderValidationMessages = (headers: unknown): string[] => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return ['headers must be a mapping of header names to non-empty string values.'];
  }
  return Object.entries(headers as Record<string, unknown>).flatMap(([name, value]) => {
    if (!HEADER_NAME.test(name)) return [`${name || '(blank)'} is not a valid email header name.`];
    if (refusedName(name)) return [`${name} cannot be declared by a pipeline.`];
    if (typeof value !== 'string' || value.trim() === '') {
      return [`${name} must have a non-empty string value.`];
    }
    if (/\r|\n/.test(value)) return [`${name} must not contain a line break.`];
    return [];
  });
};

export const emailHeaderTemplateFields = (headers: unknown): string[] => (
  !headers || typeof headers !== 'object' || Array.isArray(headers)
    ? []
    : Object.values(headers as Record<string, unknown>).flatMap((value) => (
      Array.from(String(value).matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}|\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}/g))
        .map((match) => String(match[1] || match[2] || '').split('.')[0])
        .filter(Boolean)
    ))
);

export const resolveEmailHeaders = ({
  headers,
  inputs,
}: {
  headers: unknown;
  inputs: Record<string, unknown>;
}): Record<string, string> => {
  if (headers === undefined || headers === null) return {};
  const messages = emailHeaderValidationMessages(headers);
  if (messages.length > 0) throw new Error(`Invalid configured email headers: ${messages.join(' ')}`);
  const resolved = Object.fromEntries(
    Object.entries(headers as Record<string, string>).map(([name, template]) => {
      const value = template.replace(
        /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}|\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}/g,
        (_match, doubleToken: string | undefined, singleToken: string | undefined) => {
          const field = doubleToken || singleToken || '';
          const input = valueAtPath(inputs, field);
          if (input === undefined || input === null || String(input).trim() === '') {
            throw new Error(`Email header "${name}" cannot resolve declared input "${field}".`);
          }
          return String(input);
        },
      );
      if (/\r|\n/.test(value)) throw new Error(`Email header "${name}" resolved to a line break.`);
      return [name, value];
    }),
  );
  return resolved;
};
