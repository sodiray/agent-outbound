import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

type DecideStep = Record<string, unknown>;

const object = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

export const optionsForDecideQuestion = ({ question, listDir }: { question: Record<string, unknown>; listDir: string }) => {
  if (!question.options_file) return object(question.options);
  const file = resolve(listDir, String(question.options_file));
  const loaded = yaml.load(readFileSync(file, 'utf8'));
  return object(loaded);
};

export const decideOutputColumnsFor = ({ step, listDir }: { step: DecideStep; listDir: string }) => Object.entries(object(step.questions)).flatMap(([id, rawQuestion]) => {
  const question = object(rawQuestion);
  if (question.type === 'yes_no') return [{ name: id, type: 'REAL', nullable: true }];
  const names = [
    { name: id, type: question.type === 'score' ? 'REAL' : 'TEXT', nullable: question.type === 'score' },
    { name: `${id}_confidence`, type: 'REAL', nullable: true },
    { name: `${id}_probabilities`, type: 'TEXT' },
  ];
  if (question.type !== 'choice' || !question.options_file) return names;
  const optionText = String(question.option_text || '').trim();
  const extras = new Set(Object.values(optionsForDecideQuestion({ question, listDir })).flatMap((option) => Object.keys(object(option)).filter((key) => key !== optionText)));
  return [...names, ...[...extras].map((key) => ({ name: `${id}_${key}`, type: 'TEXT' }))];
});
