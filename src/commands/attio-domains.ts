import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getEnv } from '../orchestrator/runtime/env.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const ATTIO_COMPANIES_QUERY_URL = 'https://api.attio.com/v2/objects/companies/records/query';
const PAGE_LIMIT = 100;
const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'yandex.com',
  'mail.com',
  'zoho.com',
]);

type AttioCompany = {
  values?: {
    domains?: Array<{
      domain?: unknown;
    }>;
  };
};

const normalizeDomain = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const urlText = raw.startsWith('//')
    ? `https:${raw}`
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
  try {
    const hostname = new URL(urlText).hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    if (!hostname || hostname.includes(' ') || !hostname.includes('.')) return '';
    return hostname;
  } catch {
    return '';
  }
};

const fetchCompanyPage = async ({
  apiKey,
  offset,
}: {
  apiKey: string;
  offset: number;
}): Promise<AttioCompany[]> => {
  const response = await fetch(ATTIO_COMPANIES_QUERY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      limit: PAGE_LIMIT,
      offset,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Attio companies query failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  const payload = await response.json() as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new Error('Attio companies query returned an invalid response: data is not an array.');
  }
  return payload.data as AttioCompany[];
};

const fetchAllCompanies = async (apiKey: string) => {
  const fetchFromOffset = async (offset: number): Promise<AttioCompany[]> => {
    const page = await fetchCompanyPage({ apiKey, offset });
    if (page.length < PAGE_LIMIT) return page;
    const remaining = await fetchFromOffset(offset + page.length);
    return [...page, ...remaining];
  };
  return fetchFromOffset(0);
};

export const attioDomainsCommand = async ({
  out = 'contacted-domains.txt',
  list = '',
}: {
  out?: string;
  list?: string;
}) => {
  const apiKey = String(getEnv('ATTIO_API_KEY') || '').trim();
  if (!apiKey) throw new Error('ATTIO_API_KEY is required for attio-domains.');

  const companies = await fetchAllCompanies(apiKey);
  const domains = new Set<string>();
  const counts = companies.reduce((summary, company) => {
    const entries = Array.isArray(company?.values?.domains) ? company.values.domains : [];
    const companyDomains = entries.reduce((usable, entry) => {
      const domain = normalizeDomain(entry?.domain);
      if (!domain) return usable;
      if (FREEMAIL_DOMAINS.has(domain)) {
        summary.freemailEntriesRejected += 1;
        return usable;
      }
      domains.add(domain);
      usable.add(domain);
      return usable;
    }, new Set<string>());
    return {
      ...summary,
      companiesWithNoUsableDomain: summary.companiesWithNoUsableDomain + (companyDomains.size === 0 ? 1 : 0),
      domainEntries: summary.domainEntries + entries.length,
    };
  }, {
    companiesWithNoUsableDomain: 0,
    domainEntries: 0,
    freemailEntriesRejected: 0,
  });
  const sortedDomains = [...domains].sort((left, right) => left.localeCompare(right));
  const baseDir = list ? resolveListDir(list) : process.cwd();
  const outputPath = resolve(baseDir, String(out || 'contacted-domains.txt'));
  const comment = [
    '# Source: Attio companies',
    `companies_scanned=${companies.length}`,
    `domain_entries=${counts.domainEntries}`,
    `unique_domains=${sortedDomains.length}`,
    `companies_with_no_usable_domain=${counts.companiesWithNoUsableDomain}`,
    `freemail_entries_rejected=${counts.freemailEntriesRejected}`,
  ].join('; ');
  writeFileSync(outputPath, `${comment}\n${sortedDomains.join('\n')}${sortedDomains.length > 0 ? '\n' : ''}`, 'utf8');

  return {
    out: outputPath,
    companies_scanned: companies.length,
    companies_with_no_usable_domain: counts.companiesWithNoUsableDomain,
    unique_domains_written: sortedDomains.length,
    freemail_entries_rejected: counts.freemailEntriesRejected,
  };
};
