import { TranscriptSegment } from '../entities/transcript-segment.entity';

/**
 * Pure decision logic for when the AI facilitator should interject with a new
 * topic. Kept free of timers and IO so it is trivially unit-testable; the
 * gateway owns the clock and calls these.
 */

/**
 * Volume trigger: enough has been said since the last nudge. `sinceLast` counts
 * transcript segments captured since the previous suggestion (or room start).
 */
export function shouldSuggestByVolume(
  sinceLast: number,
  everySegments: number,
): boolean {
  return everySegments > 0 && sinceLast >= everySegments;
}

/**
 * Silence trigger: the room is live and has been quiet for at least `silenceMs`.
 * Requires that at least one thing was said (`hasSpoken`) so we never nudge an
 * empty room, and that no suggestion is already the most recent event.
 */
export function shouldSuggestBySilence(params: {
  isLive: boolean;
  hasSpoken: boolean;
  msSinceLastSegment: number;
  silenceMs: number;
}): boolean {
  const { isLive, hasSpoken, msSinceLastSegment, silenceMs } = params;
  return isLive && hasSpoken && msSinceLastSegment >= silenceMs;
}

/**
 * Render a rolling transcript window into plain text the model can read, one
 * line per utterance: `Name: text`. Falls back to the speaker id when no name.
 */
export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `${s.speakerName ?? s.speakerId}: ${s.text}`)
    .join('\n');
}
