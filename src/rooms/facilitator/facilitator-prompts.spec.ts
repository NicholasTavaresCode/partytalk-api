import { HostMessage } from '../entities/host-message.entity';
import { TranscriptSegment } from '../entities/transcript-segment.entity';
import {
  buildHostPrompt,
  buildOpeningTopicPrompt,
  buildReportPrompt,
  OPENING_TOPIC_AREAS,
  parseHostTurn,
  parseOpeningTopic,
  parseReport,
} from './facilitator-prompts';

const transcript: TranscriptSegment[] = [
  {
    id: '1',
    roomId: 'r',
    speakerId: 'u1',
    speakerName: 'Ada',
    text: 'I love the beach.',
    at: '2026-01-01T10:00:00.000Z',
  },
  {
    id: '2',
    roomId: 'r',
    speakerId: 'u2',
    speakerName: 'Bo',
    text: 'Me too, especially surfing.',
    at: '2026-01-01T10:00:05.000Z',
  },
];

/** Said before the current listening window. */
const earlierHostLine: HostMessage = {
  id: 'h0',
  roomId: 'r',
  message: "All right. Let's talk about the incredible movie Titanic.",
  topic: 'The movie Titanic',
  reason: 'holidays were exhausted',
  trigger: 'volume',
  at: '2026-01-01T09:50:00.000Z',
};

/** Said in the middle of the current listening window. */
const hostLine: HostMessage = {
  id: 'h1',
  roomId: 'r',
  message: "Ok. Now let's talk about the Usain Bolt record.",
  topic: 'The Usain Bolt record',
  reason: 'the group ran dry',
  trigger: 'silence',
  at: '2026-01-01T10:00:02.000Z',
};

describe('facilitator-prompts', () => {
  describe('buildOpeningTopicPrompt', () => {
    it('asks the host for one concrete opening topic from the given area, as JSON', () => {
      const req = buildOpeningTopicPrompt({ area: 'moments in history' });
      expect(req.json).toBe(true);
      expect(req.system).toContain('about to open');
      expect(req.system).toContain('"topic"');
      expect(req.messages[0].content).toContain('moments in history');
    });

    it('offers a spread of distinct areas to draw from', () => {
      expect(OPENING_TOPIC_AREAS.length).toBeGreaterThanOrEqual(5);
      expect(new Set(OPENING_TOPIC_AREAS).size).toBe(
        OPENING_TOPIC_AREAS.length,
      );
    });
  });

  describe('parseOpeningTopic', () => {
    it('parses and trims the topic', () => {
      expect(parseOpeningTopic('{"topic":"  The movie Titanic "}')).toBe(
        'The movie Titanic',
      );
    });

    it('parses fenced JSON', () => {
      expect(
        parseOpeningTopic('```json\n{"topic":"Street food in Bangkok"}\n```'),
      ).toBe('Street food in Bangkok');
    });

    it('caps an overlong topic at the room limit', () => {
      expect(
        parseOpeningTopic(JSON.stringify({ topic: 'x'.repeat(200) })),
      ).toHaveLength(120);
    });

    it('throws on invalid JSON or a missing/empty topic', () => {
      expect(() => parseOpeningTopic('nope')).toThrow();
      expect(() => parseOpeningTopic('{}')).toThrow();
      expect(() => parseOpeningTopic('{"topic":"   "}')).toThrow();
    });
  });

  describe('buildHostPrompt', () => {
    it('casts the model as an always-listening host that pivots to unrelated topics in its own voice', () => {
      const req = buildHostPrompt({
        seedTopic: 'holidays',
        transcript,
        hostMessages: [],
        trigger: 'volume',
      });
      expect(req.json).toBe(true);
      expect(req.system).toContain('keep listening');
      expect(req.system).toContain('COMPLETELY DIFFERENT');
      expect(req.system).toContain('shouldSpeak');
      expect(req.system).toContain(
        "Ok. Now let's talk about the Usain Bolt record.",
      );
      expect(req.messages[0].content).toContain('Ada: I love the beach.');
      expect(req.messages[0].content).toContain(
        'Bo: Me too, especially surfing.',
      );
    });

    it('treats the opening topic as current until the host has spoken', () => {
      const req = buildHostPrompt({
        seedTopic: 'holidays',
        transcript,
        hostMessages: [],
        trigger: 'volume',
      });
      expect(req.messages[0].content).toContain('Current topic: "holidays"');
      expect(req.messages[0].content).toContain(
        'Topics already covered (never reuse): "holidays".',
      );
    });

    it("weaves the host's own lines into the conversation and tracks current + covered topics", () => {
      const req = buildHostPrompt({
        seedTopic: 'holidays',
        transcript,
        hostMessages: [earlierHostLine, hostLine],
        trigger: 'volume',
      });
      const content = req.messages[0].content;

      expect(content).toContain('Current topic: "The Usain Bolt record"');
      expect(content).toContain(
        '"holidays", "The movie Titanic", "The Usain Bolt record"',
      );
      // The line said inside the window appears in place, between the two
      // utterances; the older one is only remembered as a covered topic.
      expect(content).toContain(
        "Host (you): Ok. Now let's talk about the Usain Bolt record.",
      );
      expect(content).not.toContain('Host (you): All right.');
      expect(content.indexOf('Ada: I love the beach.')).toBeLessThan(
        content.indexOf('Host (you): Ok.'),
      );
      expect(content.indexOf('Host (you): Ok.')).toBeLessThan(
        content.indexOf('Bo: Me too'),
      );
    });

    it('tells the host when the room has fallen quiet (silence trigger)', () => {
      const req = buildHostPrompt({
        seedTopic: 't',
        transcript,
        hostMessages: [],
        trigger: 'silence',
      });
      expect(req.messages[0].content).toContain('fallen quiet');
    });

    it('tells the host when someone asked for a change (manual trigger)', () => {
      const req = buildHostPrompt({
        seedTopic: 't',
        transcript,
        hostMessages: [],
        trigger: 'manual',
      });
      expect(req.messages[0].content).toContain(
        'asked you to change the topic',
      );
    });

    it('handles an empty conversation gracefully', () => {
      const req = buildHostPrompt({
        seedTopic: 't',
        transcript: [],
        hostMessages: [],
        trigger: 'volume',
      });
      expect(req.messages[0].content).toContain('no one has spoken yet');
    });
  });

  describe('parseHostTurn', () => {
    it('parses the decision with the line to say, the new topic and the reason', () => {
      expect(
        parseHostTurn(
          '{"shouldSpeak":true,"message":"Ok. Now let\'s talk about the Usain Bolt record.","topic":"The Usain Bolt record","reason":"they ran dry"}',
        ),
      ).toEqual({
        shouldSpeak: true,
        message: "Ok. Now let's talk about the Usain Bolt record.",
        topic: 'The Usain Bolt record',
        reason: 'they ran dry',
      });
    });

    it('defaults shouldSpeak to false when absent or non-boolean', () => {
      expect(
        parseHostTurn(
          '{"shouldSpeak":"yes","message":"m","topic":"t","reason":"r"}',
        ),
      ).toMatchObject({ shouldSpeak: false });
      expect(
        parseHostTurn('{"message":"m","topic":"t","reason":"r"}'),
      ).toMatchObject({ shouldSpeak: false });
    });

    it('tolerates a missing reason', () => {
      expect(parseHostTurn('{"message":"m","topic":"t"}')).toEqual({
        shouldSpeak: false,
        message: 'm',
        topic: 't',
        reason: '',
      });
    });

    it('parses fenced JSON', () => {
      expect(
        parseHostTurn(
          '```json\n{"shouldSpeak":true,"message":"M","topic":"T","reason":"R"}\n```',
        ),
      ).toEqual({ shouldSpeak: true, message: 'M', topic: 'T', reason: 'R' });
    });

    it('throws on invalid JSON', () => {
      expect(() => parseHostTurn('not json')).toThrow();
    });

    it('throws when the line to say or the topic is missing', () => {
      expect(() => parseHostTurn('{"topic":"only"}')).toThrow();
      expect(() => parseHostTurn('{"message":"only"}')).toThrow();
    });
  });

  describe('buildReportPrompt', () => {
    it('requests JSON and includes the opening topic, the transcript and the host’s topic changes', () => {
      const req = buildReportPrompt({
        seedTopic: 'holidays',
        transcript,
        hostMessages: [hostLine],
      });
      expect(req.json).toBe(true);
      expect(req.system).toContain('adapted');
      expect(req.messages[0].content).toContain('holidays');
      expect(req.messages[0].content).toContain('Ada: I love the beach.');
      expect(req.messages[0].content).toContain(
        "Host: Ok. Now let's talk about the Usain Bolt record.",
      );
    });

    it('handles a room that ended without conversation', () => {
      const req = buildReportPrompt({
        seedTopic: 'holidays',
        transcript: [],
        hostMessages: [],
      });
      expect(req.messages[0].content).toContain('no conversation');
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
