export const REVIEW_DETAIL_RENDERERS = ['text', 'link', 'email', 'phone'] as const;

export type ReviewDetailRenderer = typeof REVIEW_DETAIL_RENDERERS[number];

export type ReviewDetailFieldItem = {
  field: string;
  as?: ReviewDetailRenderer;
};

export type ReviewDetailListItem = {
  text: string;
  as?: ReviewDetailRenderer;
};

export type ReviewDetailColumn = {
  field: string;
  as?: ReviewDetailRenderer;
};

export type ReviewDetailSection =
  | {
    title: string;
    items: Array<string | ReviewDetailFieldItem>;
  }
  | {
    title: string;
    from: string;
    as: 'list';
    item: ReviewDetailListItem;
  }
  | {
    title: string;
    from: string;
    as: 'table';
    columns: Array<string | ReviewDetailColumn>;
  };

export type ResolvedReviewDetailSection =
  | {
    kind: 'fields';
    title: string;
    items: Array<{ field: string; renderer: ReviewDetailRenderer; value: string }>;
  }
  | {
    kind: 'list';
    title: string;
    renderer: ReviewDetailRenderer;
    items: string[];
  }
  | {
    kind: 'table';
    title: string;
    columns: Array<{ field: string; renderer: ReviewDetailRenderer }>;
    rows: Array<Array<string | null>>;
  };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmpty = (value: unknown) => (
  value === null
  || value === undefined
  || (typeof value === 'string' && value.trim() === '')
);

const displayValue = (value: unknown): string | null => {
  if (isEmpty(value)) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const readPath = (value: unknown, path: string): unknown => path
  .split('.')
  .reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    if (['__proto__', 'constructor', 'prototype'].includes(segment)) return undefined;
    return Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined;
  }, value);

const parseArray = (value: unknown): unknown[] | null => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const fieldItem = (item: string | ReviewDetailFieldItem): ReviewDetailFieldItem => (
  typeof item === 'string' ? { field: item } : item
);

const columnItem = (column: string | ReviewDetailColumn): ReviewDetailColumn => (
  typeof column === 'string' ? { field: column } : column
);

const resolveFields = ({
  section,
  record,
}: {
  section: Extract<ReviewDetailSection, { items: Array<string | ReviewDetailFieldItem> }>;
  record: Record<string, unknown>;
}): ResolvedReviewDetailSection | null => {
  const items = section.items.flatMap((item) => {
    const normalized = fieldItem(item);
    const value = displayValue(record[normalized.field]);
    if (value === null) return [];
    return [{
      field: normalized.field,
      renderer: normalized.as || 'text',
      value,
    }];
  });
  return items.length > 0 ? { kind: 'fields', title: section.title, items } : null;
};

const resolveList = ({
  section,
  record,
}: {
  section: Extract<ReviewDetailSection, { as: 'list' }>;
  record: Record<string, unknown>;
}): ResolvedReviewDetailSection | null => {
  const source = parseArray(record[section.from]);
  if (!source) return null;
  const items = source.flatMap((element) => {
    const value = displayValue(readPath(element, section.item.text));
    return value === null ? [] : [value];
  });
  return items.length > 0
    ? { kind: 'list', title: section.title, renderer: section.item.as || 'text', items }
    : null;
};

const resolveTable = ({
  section,
  record,
}: {
  section: Extract<ReviewDetailSection, { as: 'table' }>;
  record: Record<string, unknown>;
}): ResolvedReviewDetailSection | null => {
  const source = parseArray(record[section.from]);
  if (!source) return null;
  const columns = section.columns.map(columnItem).map((column) => ({
    field: column.field,
    renderer: column.as || 'text',
  }));
  const rows = source.flatMap((element) => {
    const row = columns.map((column) => displayValue(readPath(element, column.field)));
    return row.some((value) => value !== null) ? [row] : [];
  });
  return rows.length > 0 ? { kind: 'table', title: section.title, columns, rows } : null;
};

export const resolveReviewDetail = ({
  detail,
  record,
}: {
  detail: ReviewDetailSection[] | undefined;
  record: Record<string, unknown>;
}): ResolvedReviewDetailSection[] | null => {
  if (!detail) return null;
  return detail.flatMap((section) => {
    if ('items' in section) {
      const resolved = resolveFields({ section, record });
      return resolved ? [resolved] : [];
    }
    if (section.as === 'list') {
      const resolved = resolveList({ section, record });
      return resolved ? [resolved] : [];
    }
    const resolved = resolveTable({ section, record });
    return resolved ? [resolved] : [];
  });
};

export const reviewDetailHref = ({ renderer, value }: { renderer: ReviewDetailRenderer; value: string }) => {
  if (renderer === 'email') return `mailto:${value}`;
  if (renderer === 'phone') return `tel:${value}`;
  if (renderer === 'link') return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return '';
};
