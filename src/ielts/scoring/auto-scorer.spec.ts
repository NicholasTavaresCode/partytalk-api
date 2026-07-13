import { ExamQuestion } from '../entities/exam.entity';
import { scoreObjective } from './auto-scorer';

const questions: ExamQuestion[] = [
  { id: 'q1', prompt: 'Capital of France?', answerKey: 'Paris' },
  { id: 'q2', prompt: '2 + 2?', answerKey: '4' },
  { id: 'q3', prompt: 'Opposite of hot?', answerKey: 'cold' },
  { id: 'q4', prompt: 'Colour of the sky?', answerKey: 'blue' },
];

describe('scoreObjective', () => {
  it('awards band 9 when every answer is correct', () => {
    const result = scoreObjective(questions, {
      q1: 'Paris',
      q2: '4',
      q3: 'cold',
      q4: 'blue',
    });
    expect(result).toEqual({ band: 9, correctCount: 4, total: 4 });
  });

  it('awards band 0 when no answer is correct', () => {
    const result = scoreObjective(questions, {
      q1: 'London',
      q2: '5',
      q3: 'warm',
      q4: 'green',
    });
    expect(result).toEqual({ band: 0, correctCount: 0, total: 4 });
  });

  it('maps a partial score to the nearest half band', () => {
    // 2/4 correct => 0.5 * 9 = 4.5
    const result = scoreObjective(questions, {
      q1: 'Paris',
      q2: '4',
      q3: 'warm',
      q4: 'green',
    });
    expect(result).toEqual({ band: 4.5, correctCount: 2, total: 4 });
  });

  it('rounds to the nearest half band (3/4 => 6.75 => 7)', () => {
    const result = scoreObjective(questions, {
      q1: 'Paris',
      q2: '4',
      q3: 'cold',
      q4: 'green',
    });
    expect(result).toEqual({ band: 7, correctCount: 3, total: 4 });
  });

  it('compares answers case-insensitively and trims whitespace', () => {
    const result = scoreObjective(questions, {
      q1: '  paris ',
      q2: '4',
      q3: 'COLD',
      q4: '  BLUE',
    });
    expect(result).toEqual({ band: 9, correctCount: 4, total: 4 });
  });

  it('treats a missing response as incorrect', () => {
    const result = scoreObjective(questions, { q1: 'Paris' });
    expect(result.correctCount).toBe(1);
    expect(result.total).toBe(4);
  });

  it('ignores questions without an answer key', () => {
    const mixed: ExamQuestion[] = [
      { id: 'q1', prompt: 'keyed', answerKey: 'yes' },
      { id: 'q2', prompt: 'essay (no key)' },
    ];
    const result = scoreObjective(mixed, { q1: 'yes', q2: 'anything' });
    expect(result).toEqual({ band: 9, correctCount: 1, total: 1 });
  });
});
