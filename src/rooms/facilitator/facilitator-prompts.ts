import { LlmGenerateRequest } from '../../ai/llm-provider';
import { RoomReport } from '../entities/room-report.entity';
import { TranscriptSegment } from '../entities/transcript-segment.entity';
import { formatTranscript } from './facilitator-policy';

/** Strip Markdown code fences the model sometimes wraps JSON in. */
function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export interface ParsedSuggestion {
  topic: string;
  rationale: string;
}

/**
 * Prompt for the in-session topic nudge. Asks the model to pivot the group to a
 * *related but divergent* topic that stretches vocabulary and forces
 * adaptability — the core of the practice-with-versatility goal — and to reply
 * as strict JSON so we can parse it deterministically.
 */
export function buildTopicSuggestionPrompt(params: {
  persona: string;
  seedTopic: string;
  transcript: TranscriptSegment[];
}): Pick<LlmGenerateRequest, 'system' | 'messages' | 'json'> {
  const system = [
    `You are the AI facilitator of a live group English-practice room.`,
    `Persona: ${params.persona}.`,
    `The room's seed topic was "${params.seedTopic}".`,
    `Your job is NOT to chat. You listen, then occasionally suggest ONE new topic or question that is related to what was just said but pushes the group somewhere fresh — to practise English with versatility, resilience and creativity.`,
    `Keep the new topic reachable for intermediate learners, open-ended, and phrased as something they can immediately talk about.`,
    `Respond with STRICT JSON only, no prose, of the form: {"topic": string, "rationale": string}. "rationale" is a short note (max 25 words) tying it to the conversation.`,
  ].join(' ');

  const transcriptText = params.transcript.length
    ? formatTranscript(params.transcript)
    : '(no one has spoken yet)';

  return {
    system,
    json: true,
    messages: [
      {
        role: 'user',
        content: `Recent conversation:\n${transcriptText}\n\nSuggest the next topic as JSON.`,
      },
    ],
  };
}

export function parseSuggestion(text: string): ParsedSuggestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    throw new Error('Facilitator returned invalid JSON for topic suggestion');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.topic !== 'string' || typeof obj.rationale !== 'string') {
    throw new Error('Topic suggestion JSON is missing required fields');
  }
  return { topic: obj.topic, rationale: obj.rationale };
}

/**
 * Prompt for the end-of-session, room-level report. Produces one combined
 * report for the whole group (not per participant), as strict JSON.
 */
export function buildReportPrompt(params: {
  seedTopic: string;
  transcript: TranscriptSegment[];
}): Pick<LlmGenerateRequest, 'system' | 'messages' | 'json'> {
  const system = [
    `You are an expert English-conversation coach writing a short report on a group practice session.`,
    `Assess the WHOLE group's talk (not individuals).`,
    `Be specific and encouraging; quote good phrases where possible and give concrete, actionable advice.`,
    `Respond with STRICT JSON only, no prose, of the form: {"summary": string, "highlights": string[], "suggestions": string[], "topicsExplored": string[]}.`,
  ].join(' ');

  const transcriptText = params.transcript.length
    ? formatTranscript(params.transcript)
    : '(the room ended with no conversation)';

  return {
    system,
    json: true,
    messages: [
      {
        role: 'user',
        content: `Seed topic: "${params.seedTopic}".\n\nFull transcript:\n${transcriptText}\n\nWrite the report as JSON.`,
      },
    ],
  };
}

export type ParsedReport = Omit<RoomReport, 'generatedAt'>;

export function parseReport(text: string): ParsedReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    throw new Error('Facilitator returned invalid JSON for the report');
  }
  const obj = parsed as Record<string, unknown>;
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

  if (typeof obj.summary !== 'string') {
    throw new Error('Report JSON is missing a summary');
  }
  return {
    summary: obj.summary,
    highlights: asStringArray(obj.highlights),
    suggestions: asStringArray(obj.suggestions),
    topicsExplored: asStringArray(obj.topicsExplored),
  };
}
