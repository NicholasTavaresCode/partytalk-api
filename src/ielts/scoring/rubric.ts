import { LlmMessage } from '../../ai/llm-provider';
import { CriterionScore, SectionResult } from '../entities/attempt.entity';
import { IeltsExam } from '../entities/exam.entity';

/** The four official IELTS Writing/Speaking assessment criteria. */
export const IELTS_RUBRIC_CRITERIA = [
  'Task Achievement',
  'Coherence and Cohesion',
  'Lexical Resource',
  'Grammatical Range and Accuracy',
] as const;

/**
 * Builds the system prompt + conversation that instructs the model to grade a
 * productive (writing/speaking) section against the IELTS band descriptors and
 * return STRICT JSON. Kept separate from the service so the prompt shape is
 * unit-testable.
 */
export function buildWritingScoringPrompt(
  exam: IeltsExam,
  responses: Record<string, string>,
): { system: string; messages: LlmMessage[] } {
  const system = [
    'You are a certified IELTS examiner grading a candidate response.',
    `Assess the ${exam.section} task against the four official IELTS criteria: ${IELTS_RUBRIC_CRITERIA.join(
      ', ',
    )}.`,
    'Each criterion is scored on the IELTS band scale from 0 to 9 in increments of 0.5.',
    'Respond with STRICT JSON only, no prose and no markdown fences, matching:',
    '{ "overallBand": number, "criteria": [{ "criterion": string, "band": number, "feedback": string }] }',
    'The "criteria" array must contain exactly one entry per criterion listed above.',
  ].join('\n');

  const tasks = exam.questions
    .map((q) => {
      const answer = responses[q.id] ?? '';
      return `Task ${q.id}:\nPrompt: ${q.prompt}\nCandidate response: ${answer}`;
    })
    .join('\n\n');

  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: `Exam: ${exam.title}\nSection: ${exam.section}\n\n${tasks}`,
    },
  ];

  return { system, messages };
}

/** Strip an optional ```json ... ``` (or bare ``` ... ```) fence from text. */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

interface RawRubricResponse {
  overallBand?: unknown;
  criteria?: unknown;
}

/**
 * Parses a rubric grading response into a SectionResult. Tolerates markdown
 * code fences around the JSON. Throws a clear Error if the payload is not valid
 * JSON or is missing required fields, so the caller can surface a 502-style
 * failure rather than persisting garbage.
 */
export function parseRubricResponse(text: string): SectionResult {
  const payload = stripJsonFence(text);

  let parsed: RawRubricResponse;
  try {
    parsed = JSON.parse(payload) as RawRubricResponse;
  } catch {
    throw new Error(
      `Rubric response was not valid JSON: ${text.slice(0, 200)}`,
    );
  }

  if (typeof parsed.overallBand !== 'number') {
    throw new Error('Rubric response is missing a numeric "overallBand".');
  }
  if (!Array.isArray(parsed.criteria)) {
    throw new Error('Rubric response is missing a "criteria" array.');
  }

  const criteria: CriterionScore[] = parsed.criteria.map((entry) => {
    const c = entry as Partial<CriterionScore>;
    if (
      typeof c.criterion !== 'string' ||
      typeof c.band !== 'number' ||
      typeof c.feedback !== 'string'
    ) {
      throw new Error(
        'Each rubric criterion must have string "criterion", numeric "band" and string "feedback".',
      );
    }
    return { criterion: c.criterion, band: c.band, feedback: c.feedback };
  });

  return { band: parsed.overallBand, criteria };
}
