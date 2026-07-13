import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LlmProvider } from '../ai/llm-provider';
import { AttemptsRepository } from './attempts.repository';
import { IeltsAttempt } from './entities/attempt.entity';
import { IeltsExam } from './entities/exam.entity';
import { ExamsRepository } from './exams.repository';
import { IeltsService } from './ielts.service';

class InMemoryExamsRepository extends ExamsRepository {
  store = new Map<string, IeltsExam>();

  async findById(id: string): Promise<IeltsExam | null> {
    return this.store.get(id) ?? null;
  }
  async listBySection(section: string, limit: number): Promise<IeltsExam[]> {
    return [...this.store.values()]
      .filter((e) => e.section === section)
      .slice(0, limit);
  }
  async create(exam: IeltsExam): Promise<IeltsExam> {
    this.store.set(exam.id, exam);
    return exam;
  }
}

class InMemoryAttemptsRepository extends AttemptsRepository {
  store = new Map<string, IeltsAttempt>();

  async findById(id: string): Promise<IeltsAttempt | null> {
    return this.store.get(id) ?? null;
  }
  async create(attempt: IeltsAttempt): Promise<IeltsAttempt> {
    this.store.set(attempt.id, attempt);
    return attempt;
  }
  async update(
    id: string,
    changes: Partial<Omit<IeltsAttempt, 'id' | 'createdAt'>>,
  ): Promise<IeltsAttempt | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...changes };
    this.store.set(id, updated);
    return updated;
  }
  async listByUser(userId: string, limit: number): Promise<IeltsAttempt[]> {
    return [...this.store.values()]
      .filter((a) => a.userId === userId)
      .slice(0, limit);
  }
}

const readingExam: IeltsExam = {
  id: 'exam-reading',
  section: 'reading',
  title: 'Reading Practice 1',
  questions: [
    { id: 'q1', prompt: 'Q1', answerKey: 'true' },
    { id: 'q2', prompt: 'Q2', answerKey: 'false' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const writingExam: IeltsExam = {
  id: 'exam-writing',
  section: 'writing',
  title: 'Writing Task 2',
  questions: [{ id: 'q1', prompt: 'Discuss both views.' }],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('IeltsService', () => {
  let service: IeltsService;
  let exams: InMemoryExamsRepository;
  let attempts: InMemoryAttemptsRepository;
  let llm: { generate: jest.Mock };

  beforeEach(async () => {
    llm = { generate: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IeltsService,
        { provide: ExamsRepository, useClass: InMemoryExamsRepository },
        { provide: AttemptsRepository, useClass: InMemoryAttemptsRepository },
        { provide: LlmProvider, useValue: llm },
      ],
    }).compile();

    service = moduleRef.get(IeltsService);
    exams = moduleRef.get(ExamsRepository);
    attempts = moduleRef.get(AttemptsRepository);

    exams.store.set(readingExam.id, readingExam);
    exams.store.set(writingExam.id, writingExam);
  });

  describe('getExam', () => {
    it('throws NotFound when the exam does not exist', async () => {
      await expect(service.getExam('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('startAttempt', () => {
    it('throws NotFound when the exam does not exist', async () => {
      await expect(
        service.startAttempt('user-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates an in_progress attempt with empty responses', async () => {
      const attempt = await service.startAttempt('user-1', 'exam-reading');
      expect(attempt.status).toBe('in_progress');
      expect(attempt.responses).toEqual({});
      expect(attempt.userId).toBe('user-1');
      expect(attempt.section).toBe('reading');
      expect(attempt.id).toBeTruthy();
      expect(await attempts.findById(attempt.id)).not.toBeNull();
    });
  });

  describe('submitResponses', () => {
    it('rejects submission by a non-owner with Forbidden', async () => {
      const attempt = await service.startAttempt('owner', 'exam-reading');
      await expect(
        service.submitResponses(attempt.id, 'intruder', { q1: 'true' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFound for a missing attempt', async () => {
      await expect(
        service.submitResponses('missing', 'user-1', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('stores responses and marks the attempt submitted', async () => {
      const attempt = await service.startAttempt('user-1', 'exam-reading');
      const updated = await service.submitResponses(attempt.id, 'user-1', {
        q1: 'true',
        q2: 'false',
      });
      expect(updated.status).toBe('submitted');
      expect(updated.responses).toEqual({ q1: 'true', q2: 'false' });
      expect(updated.submittedAt).toBeTruthy();
    });

    it('rejects submitting an already-scored attempt with Conflict', async () => {
      const attempt = await service.startAttempt('user-1', 'exam-reading');
      await service.submitResponses(attempt.id, 'user-1', { q1: 'true' });
      await service.scoreAttempt(attempt.id, 'user-1');
      await expect(
        service.submitResponses(attempt.id, 'user-1', { q1: 'false' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('scoreAttempt', () => {
    it('throws NotFound for a missing attempt', async () => {
      await expect(
        service.scoreAttempt('missing', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('objectively scores a reading attempt without calling the LLM', async () => {
      const attempt = await service.startAttempt('user-1', 'exam-reading');
      await service.submitResponses(attempt.id, 'user-1', {
        q1: 'TRUE',
        q2: 'false',
      });
      const scored = await service.scoreAttempt(attempt.id, 'user-1');

      expect(scored.status).toBe('scored');
      expect(scored.result).toEqual({ band: 9, correctCount: 2, total: 2 });
      expect(scored.scoredAt).toBeTruthy();
      expect(llm.generate).not.toHaveBeenCalled();
    });

    it('scores a writing attempt via the LLM with json:true and parses the rubric', async () => {
      llm.generate.mockResolvedValue({
        text: JSON.stringify({
          overallBand: 6.5,
          criteria: [
            {
              criterion: 'Task Achievement',
              band: 6,
              feedback: 'Covers the task.',
            },
            {
              criterion: 'Coherence and Cohesion',
              band: 7,
              feedback: 'Well organised.',
            },
          ],
        }),
      });

      const attempt = await service.startAttempt('user-1', 'exam-writing');
      await service.submitResponses(attempt.id, 'user-1', {
        q1: 'My essay body...',
      });
      const scored = await service.scoreAttempt(attempt.id, 'user-1');

      expect(llm.generate).toHaveBeenCalledTimes(1);
      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ json: true }),
      );
      expect(scored.result?.band).toBe(6.5);
      expect(scored.result?.criteria).toHaveLength(2);
      expect(scored.result?.criteria?.[0].criterion).toBe('Task Achievement');
    });

    it('rejects scoring an attempt owned by another user', async () => {
      const attempt = await service.startAttempt('owner', 'exam-reading');
      await expect(
        service.scoreAttempt(attempt.id, 'intruder'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listUserAttempts', () => {
    it('returns only the given user attempts', async () => {
      await service.startAttempt('user-1', 'exam-reading');
      await service.startAttempt('user-1', 'exam-writing');
      await service.startAttempt('user-2', 'exam-reading');

      const list = await service.listUserAttempts('user-1', 20);
      expect(list).toHaveLength(2);
      expect(list.every((a) => a.userId === 'user-1')).toBe(true);
    });
  });
});
