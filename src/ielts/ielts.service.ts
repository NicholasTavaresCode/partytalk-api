import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LlmProvider } from '../ai/llm-provider';
import { AttemptsRepository } from './attempts.repository';
import { IeltsAttempt } from './entities/attempt.entity';
import { IeltsExam, IeltsSection } from './entities/exam.entity';
import { ExamsRepository } from './exams.repository';
import { scoreObjective } from './scoring/auto-scorer';
import {
  buildWritingScoringPrompt,
  parseRubricResponse,
} from './scoring/rubric';

/** Sections graded objectively against an answer key (no LLM call). */
const OBJECTIVE_SECTIONS: ReadonlySet<IeltsSection> = new Set([
  'listening',
  'reading',
]);

/**
 * Owns IELTS attempt/scoring business rules. Depends only on abstract
 * repository + LLM tokens (arch-use-repository-pattern), so it is fully
 * unit-testable with in-memory fakes and a mocked LlmProvider. Scoring maths
 * live in pure functions under ./scoring (arch-single-responsibility).
 */
@Injectable()
export class IeltsService {
  constructor(
    private readonly examsRepository: ExamsRepository,
    private readonly attemptsRepository: AttemptsRepository,
    private readonly llm: LlmProvider,
  ) {}

  listExams(section: IeltsSection, limit: number): Promise<IeltsExam[]> {
    return this.examsRepository.listBySection(section, limit);
  }

  async getExam(id: string): Promise<IeltsExam> {
    const exam = await this.examsRepository.findById(id);
    if (!exam) {
      throw new NotFoundException(`Exam ${id} not found`);
    }
    return exam;
  }

  async startAttempt(userId: string, examId: string): Promise<IeltsAttempt> {
    const exam = await this.getExam(examId);

    const attempt: IeltsAttempt = {
      id: crypto.randomUUID(),
      userId,
      examId: exam.id,
      section: exam.section,
      responses: {},
      status: 'in_progress',
      createdAt: new Date().toISOString(),
    };
    return this.attemptsRepository.create(attempt);
  }

  async submitResponses(
    attemptId: string,
    userId: string,
    responses: Record<string, string>,
  ): Promise<IeltsAttempt> {
    const attempt = await this.loadOwnedAttempt(attemptId, userId);
    if (attempt.status === 'scored') {
      throw new ConflictException(
        `Attempt ${attemptId} has already been scored`,
      );
    }

    const updated = await this.attemptsRepository.update(attemptId, {
      responses,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
    });
    return updated ?? this.loadOwnedAttempt(attemptId, userId);
  }

  async scoreAttempt(
    attemptId: string,
    userId: string,
  ): Promise<IeltsAttempt> {
    const attempt = await this.loadOwnedAttempt(attemptId, userId);
    const exam = await this.getExam(attempt.examId);

    const result = OBJECTIVE_SECTIONS.has(exam.section)
      ? scoreObjective(exam.questions, attempt.responses)
      : await this.scoreWithRubric(exam, attempt.responses);

    const updated = await this.attemptsRepository.update(attemptId, {
      result,
      status: 'scored',
      scoredAt: new Date().toISOString(),
    });
    return updated ?? this.loadOwnedAttempt(attemptId, userId);
  }

  listUserAttempts(userId: string, limit: number): Promise<IeltsAttempt[]> {
    return this.attemptsRepository.listByUser(userId, limit);
  }

  private async scoreWithRubric(
    exam: IeltsExam,
    responses: Record<string, string>,
  ) {
    const { system, messages } = buildWritingScoringPrompt(exam, responses);
    const { text } = await this.llm.generate({ system, messages, json: true });
    return parseRubricResponse(text);
  }

  /** Load an attempt, enforcing existence and caller ownership. */
  private async loadOwnedAttempt(
    attemptId: string,
    userId: string,
  ): Promise<IeltsAttempt> {
    const attempt = await this.attemptsRepository.findById(attemptId);
    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptId} not found`);
    }
    if (attempt.userId !== userId) {
      throw new ForbiddenException('You do not own this attempt');
    }
    return attempt;
  }
}
