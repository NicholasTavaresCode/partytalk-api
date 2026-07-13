import { parseRubricResponse } from './rubric';

const validPayload = {
  overallBand: 7,
  criteria: [
    {
      criterion: 'Task Achievement',
      band: 7,
      feedback: 'Addresses all parts of the task.',
    },
    {
      criterion: 'Coherence and Cohesion',
      band: 6.5,
      feedback: 'Logical progression, occasional lapses.',
    },
  ],
};

describe('parseRubricResponse', () => {
  it('parses a plain JSON rubric response into a SectionResult', () => {
    const result = parseRubricResponse(JSON.stringify(validPayload));
    expect(result.band).toBe(7);
    expect(result.criteria).toHaveLength(2);
    expect(result.criteria?.[0]).toEqual({
      criterion: 'Task Achievement',
      band: 7,
      feedback: 'Addresses all parts of the task.',
    });
  });

  it('tolerates a ```json fenced payload', () => {
    const fenced = '```json\n' + JSON.stringify(validPayload) + '\n```';
    const result = parseRubricResponse(fenced);
    expect(result.band).toBe(7);
    expect(result.criteria).toHaveLength(2);
  });

  it('tolerates a bare ``` fenced payload', () => {
    const fenced = '```\n' + JSON.stringify(validPayload) + '\n```';
    expect(parseRubricResponse(fenced).band).toBe(7);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRubricResponse('not json at all')).toThrow(Error);
  });

  it('throws when overallBand is missing', () => {
    expect(() =>
      parseRubricResponse(JSON.stringify({ criteria: [] })),
    ).toThrow(/overallBand/);
  });

  it('throws when criteria is not an array', () => {
    expect(() =>
      parseRubricResponse(JSON.stringify({ overallBand: 7, criteria: {} })),
    ).toThrow(/criteria/);
  });

  it('throws when a criterion entry is malformed', () => {
    expect(() =>
      parseRubricResponse(
        JSON.stringify({
          overallBand: 7,
          criteria: [{ criterion: 'Task Achievement', band: 'seven' }],
        }),
      ),
    ).toThrow(Error);
  });
});
