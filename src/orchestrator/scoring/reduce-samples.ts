/**
 * Median reduction over independent graded score samples.
 *
 * Shared by the retired global graded scorer and the live score-stage path.
 * Even-sized sets use the lower middle (an observed grade, never an average).
 */

export type GradedSampleCriterion = {
  id: string;
  reasoning: string;
  evidence_ids?: string[];
  assessable: boolean;
  grade?: number;
};

export type GradedSampleResult = {
  criteria: GradedSampleCriterion[];
  summary_reasoning?: string;
};

export const reduceGradedCriteriaSamples = ({
  criteria,
  samples,
}: {
  criteria: Array<{ id: string }>;
  samples: GradedSampleResult[];
}): Map<string, GradedSampleCriterion> => {
  const returnedById = new Map<string, GradedSampleCriterion>();
  for (const criterion of criteria) {
    const candidates = samples.flatMap((sample) => {
      const result = sample.criteria.find((item) => String(item.id || '').trim() === criterion.id);
      return result ? [result] : [];
    });
    if (candidates.length === 0) continue;

    const assessableCandidates = candidates.filter((candidate) => candidate.assessable);
    // A strict majority of successful samples must assess the criterion. A tie
    // is unavailable rather than a speculative grade; omitted criteria count as
    // unavailable because the prompt requires every configured criterion.
    if (assessableCandidates.length <= samples.length / 2) {
      const representative = candidates.find((candidate) => candidate.assessable === false) || candidates[0];
      returnedById.set(criterion.id, { ...representative, assessable: false, grade: undefined });
      continue;
    }

    const grades = assessableCandidates.map((candidate) => Number(candidate.grade)).sort((a, b) => a - b);
    // The lower median keeps even-sized reductions on an observed grade.
    const grade = grades[Math.floor((grades.length - 1) / 2)];

    // Prefer a representative that actually cited evidence. Downstream, a
    // criterion whose evidence_ids are empty is hard-zeroed — so picking the
    // sample nearest the median WITHOUT regard to citations throws away
    // citations that other samples did produce, and zeroes a criterion the
    // model reasoned about perfectly well. Observed: a lead scored 56.7 on a
    // single sample and 7.5 on median-of-5, with substantive reasoning on every
    // criterion and evidence on one, because the chosen representatives happened
    // to be the uncited ones. Citation quality must not depend on which sample
    // sat nearest the median.
    const cited = assessableCandidates.filter((candidate) => (
      Array.isArray(candidate.evidence_ids) && candidate.evidence_ids.length > 0
    ));
    const pool = cited.length > 0 ? cited : assessableCandidates;
    const representative = pool.reduce((closest, candidate) => (
      Math.abs(Number(candidate.grade) - grade) < Math.abs(Number(closest.grade) - grade)
        ? candidate
        : closest
    ));
    returnedById.set(criterion.id, { ...representative, assessable: true, grade });
  }
  return returnedById;
};

/** Positive integer sample count; undeclared / invalid → 1 (preserve single-draw cost). */
export const resolvedScoreSamples = (value: unknown): number => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
};
