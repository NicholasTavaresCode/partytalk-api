import { TranscriptSegment } from '../entities/transcript-segment.entity';
import {
  buildReportPrompt,
  buildTopicSuggestionPrompt,
  parseReport,
  parseSuggestion,
} from './facilitator-prompts';

const transcript: TranscriptSegment[] = [
  { id: '1', roomId: 'r', speakerId: 'u1', speakerName: 'Ada', text: 'I love the beach.', at: 't1' },
  { id: '2', roomId: 'r', speakerId: 'u2', speakerName: 'Bo', text: 'Me too, especially surfing.', at: 't2' },
];

describe('facilitator-prompts', () => {
  describe('buildTopicSuggestionPrompt', () => {
    it('requests JSON and embeds persona, seed topic and transcript', () => {
      const req = buildTopicSuggestionPrompt({
        persona: 'Playful coach',
        seedTopic: 'holidays',
        transcript,
      });
      expect(req.json).toBe(true);
      expect(req.system).toContain('Playful coach');
      expect(req.system).toContain('holidays');
      expect(req.messages[0].content).toContain('Ada: I love the beach.');
      expect(req.messages[0].content).toContain('Bo: Me too, especially surfing.');
    });

    it('handles an empty transcript gracefully', () => {
      const req = buildTopicSuggestionPrompt({
        persona: 'p',
        seedTopic: 't',
        transcript: [],
      });
      expect(req.messages[0].content).toContain('no one has spoken yet');
    });
  });

  describe('parseSuggestion', () => {
    it('parses plain JSON', () => {
      expect(
        parseSuggestion('{"topic":"Dream trips","rationale":"builds on surfing"}'),
      ).toEqual({ topic: 'Dream trips', rationale: 'builds on surfing' });
    });

    it('parses fenced JSON', () => {
      expect(
        parseSuggestion('```json\n{"topic":"X","rationale":"Y"}\n```'),
      ).toEqual({ topic: 'X', rationale: 'Y' });
    });

    it('throws on invalid JSON', () => {
      expect(() => parseSuggestion('not json')).toThrow();
    });

    it('throws when required fields are missing', () => {
      expect(() => parseSuggestion('{"topic":"only"}')).toThrow();
    });
  });

  describe('buildReportPrompt', () => {
    it('requests JSON and includes the transcript and seed topic', () => {
      const req = buildReportPrompt({ seedTopic: 'holidays', transcript });
      expect(req.json).toBe(true);
      expect(req.messages[0].content).toContain('holidays');
      expect(req.messages[0].content).toContain('Ada: I love the beach.');
    });
  });

  describe('parseReport', () => {
    it('parses a full report and coerces missing arrays to []', () => {
      const result = parseReport(
        '{"summary":"Great chat","highlights":["good vocab"],"suggestions":["use past tense"]}',
      );
      expect(result.summary).toBe('Great chat');
      expect(result.highlights).toEqual(['good vocab']);
      expect(result.suggestions).toEqual(['use past tense']);
      expect(result.topicsExplored).toEqual([]);
    });

    it('parses fenced JSON', () => {
      const result = parseReport('```json\n{"summary":"ok"}\n```');
      expect(result.summary).toBe('ok');
    });

    it('throws when summary is missing', () => {
      expect(() => parseReport('{"highlights":[]}')).toThrow();
    });
  });
});
