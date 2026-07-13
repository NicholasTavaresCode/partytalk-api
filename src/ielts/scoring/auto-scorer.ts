import { SectionResult } from '../entities/attempt.entity';
import { ExamQuestion } from '../entities/exam.entity';

/** Normalize an answer for comparison: trimmed + lower-cased. */
function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Round to the nearest 0.5, the granularity of the IELTS band scale. */
function roundToHalfBand(value: number): number {
  return Math.round(value * 2) / 2;
}

/** Clamp a raw band into the valid IELTS 0–9 range. */
function clampBand(band: number): number {
  return Math.min(9, Math.max(0, band));
}

/**
 * Objectively scores a listening/reading section by comparing each response to
 * its answer key (case-insensitive, whitespace-trimmed). The proportion correct
 * is mapped linearly onto the 0–9 band scale and rounded to the nearest half
 * band. Pure and deterministic so it can be unit-tested without a service.
 */
export function scoreObjective(
  questions: ExamQuestion[],
  responses: Record<string, string>,
): SectionResult {
  const scorable = questions.filter((q) => q.answerKey !== undefined);
  const total = scorable.length;

  const correctCount = scorable.filter(
    (q) => normalize(responses[q.id]) === normalize(q.answerKey),
  ).length;

  const ratio = total === 0 ? 0 : correctCount / total;
  const band = clampBand(roundToHalfBand(ratio * 9));

  return { band, correctCount, total };
}
