import {
  extractText,
  toGenerationConfig,
  toVertexContents,
} from './vertex-mapping';

describe('vertex-mapping', () => {
  describe('toVertexContents', () => {
    it('maps roles and wraps content in text parts', () => {
      expect(
        toVertexContents([
          { role: 'user', content: 'Hi' },
          { role: 'model', content: 'Hello!' },
        ]),
      ).toEqual([
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello!' }] },
      ]);
    });
  });

  describe('toGenerationConfig', () => {
    it('omits unset fields', () => {
      expect(toGenerationConfig({ messages: [] })).toEqual({});
    });

    it('requests JSON mime type when json is set', () => {
      expect(
        toGenerationConfig({ messages: [], json: true, temperature: 0.2 }),
      ).toEqual({ responseMimeType: 'application/json', temperature: 0.2 });
    });
  });

  describe('extractText', () => {
    it('joins and trims candidate parts', () => {
      expect(
        extractText({
          candidates: [{ content: { parts: [{ text: ' Hello ' }, { text: 'world' }] } }],
        }),
      ).toBe('Hello world');
    });

    it('returns empty string when there are no candidates', () => {
      expect(extractText({})).toBe('');
      expect(extractText({ candidates: [] })).toBe('');
    });
  });
});
