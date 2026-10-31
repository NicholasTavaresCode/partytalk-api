import { LlmGenerateRequest } from '../../ai/llm-provider';
import { HostMessage, HostTrigger } from '../entities/host-message.entity';
import { RoomReport } from '../entities/room-report.entity';
import { TranscriptSegment } from '../entities/transcript-segment.entity';
import { formatConversation, HOST_SPEAKER_LABEL } from './facilitator-policy';

/** Strip Markdown code fences the model sometimes wraps JSON in. */
function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** Areas the host draws an opening topic from; one is picked at random per room for variety. */
export const OPENING_TOPIC_AREAS: readonly string[] = [
  'sport and famous records',
  'movies and TV series',
  'food and cooking',
  'travel and cities',
  'science and inventions',
  'moments in history',
  'music and concerts',
  'technology and gadgets',
  'nature and animals',
  'everyday life and habits',
];

/** Longest opening topic accepted from the model (mirrors the creator's limit). */
const OPENING_TOPIC_MAX_LENGTH = 120;

/**
 * Prompt for the host to pick a room's opening topic (room created with
 * `hostPicksTopic`). Nothing has been said yet, so the only context is an area
 * to draw from — the caller picks it at random so rooms do not all open on the
 * same subject. Replies as strict JSON.
 */
export function buildOpeningTopicPrompt(params: {
  area: string;
}): Pick<LlmGenerateRequest, 'system' | 'messages' | 'json'> {
  const system = [
    `You are the AI host of a live group English-practice room that is about to open.`,
    `Pick ONE concrete, vivid opening topic that intermediate learners can start talking about immediately — a specific thing, not a broad theme: for example "The Usain Bolt 100m record", "The movie Titanic" or "Street food in Bangkok".`,
    `Make it open-ended (opinions, memories, comparisons), reachable without expert knowledge, and at most 10 words.`,
    `Respond with STRICT JSON only, no prose: {"topic": string}.`,
  ].join(' ');

  return {
    system,
    json: true,
    messages: [
      {
        role: 'user',
        content: `Draw the opening topic from this area: ${params.area}. Surprise the group — avoid the most obvious pick. Reply as JSON.`,
      },
    ],
  };
}

export function parseOpeningTopic(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    throw new Error('Host returned invalid JSON for the opening topic');
  }
  const topic = (parsed as Record<string, unknown>).topic;
  if (typeof topic !== 'string' || !topic.trim()) {
    throw new Error('Opening topic JSON is missing a topic');
  }
  return topic.trim().slice(0, OPENING_TOPIC_MAX_LENGTH);
}

/** The host's decision for one turn, as parsed from the model's JSON reply. */
export interface HostTurn {
  /** Whether the host judged that now is the moment to step in. */
  shouldSpeak: boolean;
  /** Exactly what the host says out loud (always filled — the manual path forces it). */
  message: string;
  /** The new topic the host moves the room onto. */
  topic: string;
  /** Why now is (or is not) the moment, in a few words. */
  reason: string;
}

/** Short hint telling the host what prompted this consultation. */
const TRIGGER_HINT: Record<HostTrigger, string> = {
  volume:
    'The group has been talking for a while since you last checked in. Judge whether the current topic has been talked about enough.',
  silence: 'The room has just fallen quiet — nobody is speaking right now.',
  manual: 'A participant has asked you to change the topic right now.',
};

/** The topic the room is on right now: the host's latest pivot, or the opening topic. */
export function currentTopic(
  seedTopic: string,
  hostMessages: HostMessage[],
): string {
  return hostMessages.at(-1)?.topic ?? seedTopic;
}

/** Every topic this room has been on: the opening one plus each host pivot. */
export function coveredTopics(
  seedTopic: string,
  hostMessages: HostMessage[],
): string[] {
  return [...new Set([seedTopic, ...hostMessages.map((m) => m.topic)])];
}

/**
 * Prompt for one host turn. The host is always in the room and keeps listening;
 * on each consultation it judges — from the conversation itself — whether the
 * current topic has been talked about enough (`shouldSpeak`). When it steps in
 * it says a short line, in the first person, that moves the group onto a
 * COMPLETELY DIFFERENT topic, so they must adapt on the spot and practise
 * English across unrelated subjects. It sees its own earlier lines and the
 * topics already covered so it never repeats itself. `message`/`topic` are
 * always filled (its best next move) so the manual override can force a
 * change; auto-triggers honour `shouldSpeak`. Replies as strict JSON.
 */
export function buildHostPrompt(params: {
  seedTopic: string;
  /** The most recent transcript window, in chronological order. */
  transcript: TranscriptSegment[];
  /** Everything the host has said so far, in chronological order. */
  hostMessages: HostMessage[];
  trigger: HostTrigger;
}): Pick<LlmGenerateRequest, 'system' | 'messages' | 'json'> {
  const system = [
    `You are the AI host of a live group English-practice room. You are always in the room and you keep listening to everything that is said.`,
    `Your job is to decide WHETHER now is the moment to step in and, when it is, to move the group onto a COMPLETELY DIFFERENT topic — unrelated to what they are discussing — so they must adapt on the spot and practise English across very different subjects.`,
    `Step in ("shouldSpeak": true) when the current topic has been talked about enough: the group is repeating itself, running out of things to say, has covered it well, or has fallen quiet. Stay out ("shouldSpeak": false) while the conversation is flowing and people still have plenty to say.`,
    `Pick concrete, vivid topics — a famous record, a movie, a city, an invention, a dish, a sport, a moment in history — that intermediate learners can start talking about immediately. Never reuse a topic already covered in this room.`,
    `When you speak, write exactly what you say out loud, in the first person, as a warm and confident host: one or two short sentences announcing the new topic, for example "Ok. Now let's talk about the Usain Bolt record." or "All right. Let's talk about the incredible movie Titanic." Do not ask permission and do not explain yourself to the group.`,
    `Respond with STRICT JSON only, no prose: {"shouldSpeak": boolean, "message": string, "topic": string, "reason": string}. Always fill "message" and "topic" with your best next move even when "shouldSpeak" is false. "reason" (max 25 words) says why now is, or is not, the moment.`,
  ].join(' ');

  // Only the host lines said within the listening window are woven into the
  // conversation; older pivots are still accounted for via the covered topics.
  const windowStart = params.transcript[0]?.at;
  const hostInWindow = windowStart
    ? params.hostMessages.filter((m) => m.at >= windowStart)
    : params.hostMessages;
  const conversation =
    params.transcript.length || hostInWindow.length
      ? formatConversation(params.transcript, hostInWindow)
      : '(no one has spoken yet)';

  const content = [
    `Situation: ${TRIGGER_HINT[params.trigger]}`,
    `Opening topic of the room: "${params.seedTopic}".`,
    `Current topic: "${currentTopic(params.seedTopic, params.hostMessages)}".`,
    `Topics already covered (never reuse): ${coveredTopics(
      params.seedTopic,
      params.hostMessages,
    )
      .map((t) => `"${t}"`)
      .join(', ')}.`,
    '',
    `Recent conversation (your own lines appear as "${HOST_SPEAKER_LABEL}"):`,
    conversation,
    '',
    `Decide whether to step in now and, if so, exactly what you say — as JSON.`,
  ].join('\n');

  return {
    system,
    json: true,
    messages: [{ role: 'user', content }],
  };
}

export function parseHostTurn(text: string): HostTurn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    throw new Error('Host returned invalid JSON');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message !== 'string' || typeof obj.topic !== 'string') {
    throw new Error('Host JSON is missing required fields (message, topic)');
  }
  // Absent/non-boolean `shouldSpeak` defaults to false so auto-triggers never
  // interrupt on a malformed reply (the manual path forces regardless).
  return {
    shouldSpeak: obj.shouldSpeak === true,
    message: obj.message,
    topic: obj.topic,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
  };
}

/**
 * Prompt for the end-of-session, room-level report. Produces one combined
 * report for the whole group (not per participant), as strict JSON. The host's
 * topic changes are part of the conversation so the coach can judge how well
 * the group adapted to each pivot.
 */
export function buildReportPrompt(params: {
  seedTopic: string;
  transcript: TranscriptSegment[];
  hostMessages: HostMessage[];
}): Pick<LlmGenerateRequest, 'system' | 'messages' | 'json'> {
  const system = [
    `You are an expert English-conversation coach writing a short report on a group practice session.`,
    `Assess the WHOLE group's talk (not individuals).`,
    `An AI host was in the room and moved the group onto new, unrelated topics as the session went on (its lines appear as "Host"); comment on how well the group adapted to each change.`,
    `Be specific and encouraging; quote good phrases where possible and give concrete, actionable advice.`,
    `Respond with STRICT JSON only, no prose, of the form: {"summary": string, "highlights": string[], "suggestions": string[], "topicsExplored": string[]}.`,
  ].join(' ');

  const conversation =
    params.transcript.length || params.hostMessages.length
      ? formatConversation(params.transcript, params.hostMessages, 'Host')
      : '(the room ended with no conversation)';

  return {
    system,
    json: true,
    messages: [
      {
        role: 'user',
        content: `Opening topic: "${params.seedTopic}".\n\nFull conversation:\n${conversation}\n\nWrite the report as JSON.`,
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
    throw new Error('Host returned invalid JSON for the report');
  }
  const obj = parsed as Record<string, unknown>;
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];

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
