import { HostMessage } from '../entities/host-message.entity';
import { TranscriptSegment } from '../entities/transcript-segment.entity';

/**
 * Pure gating logic for WHEN the gateway should consult the AI host (which then
 * makes the real call on whether to step in). Kept free of timers and IO so it
 * is trivially unit-testable; the gateway owns the clock and calls these, and
 * the LLM owns the final decision.
 */

/**
 * Volume gate: enough has been said since the last check to be worth consulting
 * the host again. `sinceLast` counts transcript segments captured since the
 * previous consultation (or room start). Bounds how often we call the model.
 */
export function shouldEvaluateByVolume(
  sinceLast: number,
  everySegments: number,
): boolean {
  return everySegments > 0 && sinceLast >= everySegments;
}

/**
 * Silence gate: the room is live and has been quiet for at least `silenceMs` —
 * a strong signal the group may be stuck, so it is worth consulting the host.
 * Requires that at least one thing was said (`hasSpoken`) so we never nudge an
 * empty room.
 */
export function shouldEvaluateBySilence(params: {
  isLive: boolean;
  hasSpoken: boolean;
  msSinceLastSegment: number;
  silenceMs: number;
}): boolean {
  const { isLive, hasSpoken, msSinceLastSegment, silenceMs } = params;
  return isLive && hasSpoken && msSinceLastSegment >= silenceMs;
}

/** How the host's own lines are labelled when it re-reads the conversation. */
export const HOST_SPEAKER_LABEL = 'Host (you)';

/**
 * Render the conversation as the host heard it: participants' utterances and
 * the host's own lines merged in time order, one line each (`Name: text`).
 * Falls back to the speaker id when a participant has no display name.
 */
export function formatConversation(
  segments: TranscriptSegment[],
  hostMessages: HostMessage[] = [],
  hostLabel: string = HOST_SPEAKER_LABEL,
): string {
  const lines = [
    ...segments.map((s) => ({
      at: s.at,
      line: `${s.speakerName ?? s.speakerId}: ${s.text}`,
    })),
    ...hostMessages.map((m) => ({
      at: m.at,
      line: `${hostLabel}: ${m.message}`,
    })),
  ];
  // Timestamps are ISO-8601, so plain string comparison orders them correctly.
  // Array.prototype.sort is stable: on a tie, participants stay before the host.
  return lines
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((l) => l.line)
    .join('\n');
}
