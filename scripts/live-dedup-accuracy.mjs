#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { confirmDuplicate, buildDedupPayload } from '../dist/orchestrator/sourcing/dedup.js';

const [inputPath, outputPath = '/tmp/agent-outbound-live-dedup-accuracy.json'] = process.argv.slice(2);
if (!inputPath) throw new Error('Usage: node scripts/live-dedup-accuracy.mjs <agent-outbound-query-output.json> [report.json]');
if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is required; load the Mission skills environment first.');

const rows = JSON.parse(readFileSync(inputPath, 'utf8')).result.rows;
const text = (value) => String(value || '').trim();
const normalized = (value) => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const groupBy = (items, key) => items.reduce((groups, item) => {
  const group = key(item);
  return { ...groups, [group]: [...(groups[group] || []), item] };
}, {});
const pairKey = (left, right) => [text(left._row_id), text(right._row_id)].sort().join('|');
const distinctApollo = (left, right) => text(left.apollo_person_id) && text(right.apollo_person_id)
  && text(left.apollo_person_id) !== text(right.apollo_person_id);

const selected = [];
const seen = new Set();
const add = (left, right, truth, category) => {
  const key = pairKey(left, right);
  if (!left || !right || left === right || seen.has(key)) return false;
  seen.add(key);
  selected.push({ left, right, truth, category });
  return true;
};

const samePeople = Object.values(groupBy(rows, (row) => text(row.apollo_person_id) || `${normalized(row.first_name)}|${normalized(row.last_name)}|${normalized(row.company)}`));
samePeople.forEach((group) => group.slice(1).forEach((row) => add(group[0], row, true, 'same_person')));

const exactNames = Object.values(groupBy(rows, (row) => `${normalized(row.first_name)}|${normalized(row.last_name)}`));
exactNames.forEach((group) => {
  const pairs = group.flatMap((left, index) => group.slice(index + 1).map((right) => [left, right]));
  pairs.filter(([left, right]) => distinctApollo(left, right) && normalized(left.company) !== normalized(right.company))
    .forEach(([left, right]) => add(left, right, false, 'same_name_different_firm'));
});

const firstNames = Object.values(groupBy(rows, (row) => normalized(row.first_name)));
firstNames.forEach((group) => {
  const pairs = group.flatMap((left, index) => group.slice(index + 1).map((right) => [left, right]));
  pairs.filter(([left, right]) => distinctApollo(left, right) && normalized(left.company) !== normalized(right.company))
    .forEach(([left, right]) => add(left, right, false, 'similar_name_different_firm'));
});

const firms = Object.values(groupBy(rows, (row) => normalized(row.company)));
firms.forEach((group) => {
  const pairs = group.flatMap((left, index) => group.slice(index + 1).map((right) => [left, right]));
  pairs.filter(([left, right]) => distinctApollo(left, right)).forEach(([left, right]) => add(left, right, false, 'same_firm_different_person'));
});

const pairs = selected.slice(0, 50);
if (pairs.length < 40) throw new Error(`Only ${pairs.length} data-grounded pairs were available; need at least 40.`);

const context = 'People who own small consulting firms; the same person has the same name and firm even when titles differ.';
const configurations = [
  { id: 'a', fields: [{ field: 'first_name', label: 'First name' }, { field: 'last_name', label: 'Last name' }, { field: 'company', label: 'Company' }] },
  { id: 'b', fields: [{ field: 'first_name', label: 'First name' }, { field: 'last_name', label: 'Last name' }, { field: 'company', label: 'Company' }, { field: 'title', label: 'Title' }] },
  { id: 'c', fields: [{ field: 'first_name', label: 'First name' }, { field: 'last_name', label: 'Last name' }, { field: 'company', label: 'Company' }, { field: 'title', label: 'Title' }, { field: 'linkedin', label: 'LinkedIn URL' }, { field: 'email_domain', label: 'Email domain' }] },
];
const aiConfig = { decide: { model: 'jev-1.13.0', api_key_env: 'JEV_API_KEY' } };
const total = (items) => items.reduce((sum, item) => sum + Number(item || 0), 0);
const distribution = (items) => ({
  count: items.length,
  min: items.length ? Math.min(...items) : null,
  median: items.length ? [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)] : null,
  mean: items.length ? total(items) / items.length : null,
  max: items.length ? Math.max(...items) : null,
});
const bestThreshold = (results) => Array.from({ length: 101 }, (_, value) => value / 100).map((threshold) => {
  const scored = results.map((result) => ({ ...result, predicted: result.same_probability >= threshold }));
  return {
    threshold,
    accuracy: scored.filter((result) => result.predicted === result.truth).length / scored.length,
    false_merges: scored.filter((result) => result.predicted && !result.truth).length,
    missed_duplicates: scored.filter((result) => !result.predicted && result.truth).length,
  };
}).sort((left, right) => right.accuracy - left.accuracy || left.false_merges - right.false_merges || left.threshold - right.threshold)[0];

const reports = [];
for (const configuration of configurations) {
  const results = [];
  for (const pair of pairs) {
    const answer = await confirmDuplicate({
      incoming: pair.left,
      candidate: pair.right,
      fields: configuration.fields,
      context,
      aiConfig,
    });
    results.push({
      truth: pair.truth,
      category: pair.category,
      same: answer.same,
      same_probability: answer.same_probability,
      confidence: answer.confidence,
      usage: answer.usage,
      record_a: buildDedupPayload({ row: pair.left, fields: configuration.fields }),
      record_b: buildDedupPayload({ row: pair.right, fields: configuration.fields }),
    });
  }
  const correct = results.filter((result) => result.same === result.truth);
  const wrong = results.filter((result) => result.same !== result.truth);
  reports.push({
    id: configuration.id,
    fields: configuration.fields,
    pair_count: results.length,
    accuracy: correct.length / results.length,
    false_merges: results.filter((result) => result.same && !result.truth).length,
    missed_duplicates: results.filter((result) => !result.same && result.truth).length,
    confidence_correct: distribution(correct.map((result) => result.confidence)),
    confidence_wrong: distribution(wrong.map((result) => result.confidence)),
    best_threshold: bestThreshold(results),
    total_cost_usd: total(results.map((result) => result.usage?.usd_cost)),
    total_input_tokens: total(results.map((result) => result.usage?.input_tokens)),
    total_output_tokens: total(results.map((result) => result.usage?.output_tokens)),
    responses_with_reported_cost: results.filter((result) => result.usage?.usd_cost !== undefined).length,
    wrong_answers: wrong.slice(0, 5),
  });
}

const report = {
  source_rows: rows.length,
  pair_count: pairs.length,
  categories: Object.fromEntries(Object.entries(groupBy(pairs, (pair) => pair.category)).map(([category, values]) => [category, values.length])),
  unavailable_requested_categories: ['same_firm_different_person', 'same_person_with_title_or_company_variation'].filter((category) => !pairs.some((pair) => pair.category === category)),
  total_cost_usd: total(reports.map((report) => report.total_cost_usd)),
  total_input_tokens: total(reports.map((report) => report.total_input_tokens)),
  total_output_tokens: total(reports.map((report) => report.total_output_tokens)),
  responses_with_reported_cost: total(reports.map((report) => report.responses_with_reported_cost)),
  reports,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, pair_count: pairs.length, categories: report.categories, total_cost_usd: report.total_cost_usd }, null, 2)}\n`);
