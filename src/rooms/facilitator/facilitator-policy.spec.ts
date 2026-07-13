import { TranscriptSegment } from '../entities/transcript-segment.entity';
import {
  formatTranscript,
  shouldSuggestBySilence,
  shouldSuggestByVolume,
} from './facilitator-policy';

describe('facilitator-policy', () => {
  describe('shouldSuggestByVolume', () => {
    it('fires once the segment count reaches the threshold', () => {
      expect(shouldSuggestByVolume(8, 8)).toBe(true);
      expect(shouldSuggestByVolume(9, 8)).toBe(true);
    });

    it('does not fire before the threshold', () => {
      expect(shouldSuggestByVolume(7, 8)).toBe(false);
    });

    it('never fires when the threshold is non-positive', () => {
      expect(shouldSuggestByVolume(100, 0)).toBe(false);
    });
  });

  describe('shouldSuggestBySilence', () => {
    const base = {
      isLive: true,
      hasSpoken: true,
      msSinceLastSegment: 30_000,
      silenceMs: 25_000,
    };

    it('fires when a live room has been quiet past the threshold', () => {
      expect(shouldSuggestBySilence(base)).toBe(true);
    });

    it('does not fire before the silence threshold', () => {
      expect(
        shouldSuggestBySilence({ ...base, msSinceLastSegment: 10_000 }),
      ).toBe(false);
    });

    it('does not fire for a room where no one has spoken', () => {
      expect(shouldSuggestBySilence({ ...base, hasSpoken: false })).toBe(false);
    });

    it('does not fire for a room that is not live', () => {
      expect(shouldSuggestBySilence({ ...base, isLive: false })).toBe(false);
    });
  });

  describe('formatTranscript', () => {
    it('renders one line per utterance, preferring speaker name', () => {
      const segments: TranscriptSegment[] = [
        { id: '1', roomId: 'r', speakerId: 'u1', speakerName: 'Ada', text: 'Hi', at: 't1' },
        { id: '2', roomId: 'r', speakerId: 'u2', text: 'Hello', at: 't2' },
      ];
      expect(formatTranscript(segments)).toBe('Ada: Hi\nu2: Hello');
    });
  });
});
