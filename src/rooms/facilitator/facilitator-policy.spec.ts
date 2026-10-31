import { HostMessage } from '../entities/host-message.entity';
import { TranscriptSegment } from '../entities/transcript-segment.entity';
import {
  formatConversation,
  shouldEvaluateBySilence,
  shouldEvaluateByVolume,
} from './facilitator-policy';

describe('facilitator-policy', () => {
  describe('shouldEvaluateByVolume', () => {
    it('fires once the segment count reaches the threshold', () => {
      expect(shouldEvaluateByVolume(8, 8)).toBe(true);
      expect(shouldEvaluateByVolume(9, 8)).toBe(true);
    });

    it('does not fire before the threshold', () => {
      expect(shouldEvaluateByVolume(7, 8)).toBe(false);
    });

    it('never fires when the threshold is non-positive', () => {
      expect(shouldEvaluateByVolume(100, 0)).toBe(false);
    });
  });

  describe('shouldEvaluateBySilence', () => {
    const base = {
      isLive: true,
      hasSpoken: true,
      msSinceLastSegment: 30_000,
      silenceMs: 25_000,
    };

    it('fires when a live room has been quiet past the threshold', () => {
      expect(shouldEvaluateBySilence(base)).toBe(true);
    });

    it('does not fire before the silence threshold', () => {
      expect(
        shouldEvaluateBySilence({ ...base, msSinceLastSegment: 10_000 }),
      ).toBe(false);
    });

    it('does not fire for a room where no one has spoken', () => {
      expect(shouldEvaluateBySilence({ ...base, hasSpoken: false })).toBe(
        false,
      );
    });

    it('does not fire for a room that is not live', () => {
      expect(shouldEvaluateBySilence({ ...base, isLive: false })).toBe(false);
    });
  });

  describe('formatConversation', () => {
    const segments: TranscriptSegment[] = [
      {
        id: '1',
        roomId: 'r',
        speakerId: 'u1',
        speakerName: 'Ada',
        text: 'Hi',
        at: '2026-01-01T10:00:00.000Z',
      },
      {
        id: '2',
        roomId: 'r',
        speakerId: 'u2',
        text: 'Hello',
        at: '2026-01-01T10:00:05.000Z',
      },
      {
        id: '3',
        roomId: 'r',
        speakerId: 'u1',
        speakerName: 'Ada',
        text: 'Bolt was so fast!',
        at: '2026-01-01T10:00:20.000Z',
      },
    ];
    const hostLine: HostMessage = {
      id: 'h1',
      roomId: 'r',
      message: "Ok. Now let's talk about the Usain Bolt record.",
      topic: 'The Usain Bolt record',
      reason: 'the greeting topic was exhausted',
      trigger: 'volume',
      at: '2026-01-01T10:00:10.000Z',
    };

    it('renders one line per utterance, preferring speaker name', () => {
      expect(formatConversation(segments.slice(0, 2))).toBe(
        'Ada: Hi\nu2: Hello',
      );
    });

    it("weaves the host's own lines into the conversation in time order", () => {
      expect(formatConversation(segments, [hostLine])).toBe(
        [
          'Ada: Hi',
          'u2: Hello',
          "Host (you): Ok. Now let's talk about the Usain Bolt record.",
          'Ada: Bolt was so fast!',
        ].join('\n'),
      );
    });

    it('lets the caller choose how the host is labelled', () => {
      expect(formatConversation([], [hostLine], 'Host')).toBe(
        "Host: Ok. Now let's talk about the Usain Bolt record.",
      );
    });
  });
});
