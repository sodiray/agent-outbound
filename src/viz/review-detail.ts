export const REVIEW_DETAIL_RENDERERS = ['text', 'link', 'email', 'phone'] as const;

export type ReviewDetailRenderer = typeof REVIEW_DETAIL_RENDERERS[number];

export type ReviewDetailFieldItem = {
  field: string;
  as?: ReviewDetailRenderer;
  label?: string;
  link_text?: string;
  show_when_empty?: boolean;
};

export type ReviewDetailListItem = {
  text: string;
  as?: ReviewDetailRenderer;
  link_text?: string;
};

export type ReviewDetailColumn = {
  field: string;
  as?: ReviewDetailRenderer;
  label?: string;
  link_text?: string;
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
  }
  | {
    title: string;
    as: 'map';
    latitude_field?: string;
    longitude_field?: string;
    coordinates_field?: string;
  }
  | {
    title: string;
    as: 'embed';
    from: string;
  };

export type ResolvedReviewDetailSection =
  | {
    kind: 'fields';
    title: string;
    items: Array<{
      field: string;
      label?: string;
      renderer: ReviewDetailRenderer;
      value: string;
      link_text?: string;
    }>;
  }
  | {
    kind: 'list';
    title: string;
    renderer: ReviewDetailRenderer;
    link_text?: string;
    items: string[];
  }
  | {
    kind: 'table';
    title: string;
    columns: Array<{
      field: string;
      label?: string;
      renderer: ReviewDetailRenderer;
      link_text?: string;
    }>;
    rows: Array<Array<string | null>>;
  }
  | {
    kind: 'map';
    title: string;
    coordinates: { lat: number; lng: number };
  }
  | {
    kind: 'embed';
    title: string;
    url: string;
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

const coordinateNumber = (value: unknown): number | null => {
  if (isEmpty(value)) return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
};

const validCoordinates = (lat: unknown, lng: unknown): { lat: number; lng: number } | null => {
  const resolvedLat = coordinateNumber(lat);
  const resolvedLng = coordinateNumber(lng);
  if (resolvedLat === null || resolvedLng === null) return null;
  if (Math.abs(resolvedLat) > 90 || Math.abs(resolvedLng) > 180) return null;
  return { lat: resolvedLat, lng: resolvedLng };
};

const parseCoordinatePair = (value: unknown): { lat: number; lng: number } | null => {
  if (Array.isArray(value)) return validCoordinates(value[0], value[1]);
  if (isRecord(value)) {
    return validCoordinates(
      value.lat ?? value.latitude,
      value.lng ?? value.lon ?? value.longitude,
    );
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return parseCoordinatePair(JSON.parse(text));
  } catch {
    const pair = text.split(',').map((part) => part.trim());
    return pair.length === 2 ? validCoordinates(pair[0], pair[1]) : null;
  }
};

const externalUrl = (value: unknown): string | null => {
  const raw = displayValue(value);
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
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
    if (value === null && !normalized.show_when_empty) return [];
    return [{
      field: normalized.field,
      ...(normalized.label ? { label: normalized.label } : {}),
      renderer: normalized.as || 'text',
      value: value || '—',
      ...(normalized.link_text ? { link_text: normalized.link_text } : {}),
    }];
  });
  return items.length > 0 ? { kind: 'fields', title: section.title, items } : null;
};

const resolveMap = ({
  section,
  record,
}: {
  section: Extract<ReviewDetailSection, { as: 'map' }>;
  record: Record<string, unknown>;
}): ResolvedReviewDetailSection | null => {
  const coordinates = section.coordinates_field
    ? parseCoordinatePair(record[section.coordinates_field])
    : validCoordinates(record[section.latitude_field || ''], record[section.longitude_field || '']);
  return coordinates ? { kind: 'map', title: section.title, coordinates } : null;
};

const resolveEmbed = ({
  section,
  record,
}: {
  section: Extract<ReviewDetailSection, { as: 'embed' }>;
  record: Record<string, unknown>;
}): ResolvedReviewDetailSection | null => {
  const url = externalUrl(record[section.from]);
  return url ? { kind: 'embed', title: section.title, url } : null;
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
    ? {
      kind: 'list',
      title: section.title,
      renderer: section.item.as || 'text',
      ...(section.item.link_text ? { link_text: section.item.link_text } : {}),
      items,
    }
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
    ...(column.label ? { label: column.label } : {}),
    renderer: column.as || 'text',
    ...(column.link_text ? { link_text: column.link_text } : {}),
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
    if (section.as === 'table') {
      const resolved = resolveTable({ section, record });
      return resolved ? [resolved] : [];
    }
    if (section.as === 'map') {
      const resolved = resolveMap({ section, record });
      return resolved ? [resolved] : [];
    }
    const resolved = resolveEmbed({ section, record });
    return resolved ? [resolved] : [];
  });
};

export const canRenderReviewDetailMap = ({
  mapsApiKey,
  coordinates,
}: {
  mapsApiKey: string;
  coordinates: { lat: number; lng: number } | null;
}) => Boolean(mapsApiKey.trim()) && coordinates !== null;

export const reviewDetailHref = ({ renderer, value }: { renderer: ReviewDetailRenderer; value: string }) => {
  if (renderer === 'email') return `mailto:${value}`;
  if (renderer === 'phone') return `tel:${value}`;
  if (renderer === 'link') return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return '';
};

export const reviewDetailLinkText = ({
  renderer,
  value,
  linkText,
}: {
  renderer: ReviewDetailRenderer;
  value: string;
  linkText?: string;
}) => {
  if (renderer !== 'link') return value;
  if (linkText?.trim()) return linkText.trim();
  try {
    return new URL(reviewDetailHref({ renderer, value })).hostname || 'Open link';
  } catch {
    return 'Open link';
  }
};
