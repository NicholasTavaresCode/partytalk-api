import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ApiEnvelopeResponse } from '../common/swagger/api-envelope';
import { ErrorResponseDto } from '../common/swagger/error-response.dto';
import { ListExamsQueryDto } from './dto/list-exams-query.dto';
import { StartAttemptDto } from './dto/start-attempt.dto';
import { SubmitResponsesDto } from './dto/submit-responses.dto';
import { IeltsAttempt } from './entities/attempt.entity';
import { IeltsExam } from './entities/exam.entity';
import { IeltsService } from './ielts.service';

/**
 * IELTS exam + attempt endpoints. The caller's id always comes from the verified
 * token (never the URL/body), so a learner can only read and score their own
 * attempts — ownership is re-checked in the service (no IDOR surface).
 */
@ApiTags('IELTS')
@ApiBearerAuth('firebase')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired Firebase token.',
  type: ErrorResponseDto,
})
@Controller({ path: 'ielts', version: '1' })
export class IeltsController {
  constructor(private readonly ieltsService: IeltsService) {}

  @Get('exams')
  @ApiOperation({
    summary: 'List exams by section',
    description:
      'Lists available IELTS exams for a single skill (`section`), newest first, capped by `limit`. Each exam bundles its ordered questions. Listening/Reading exams carry an answer key per question (used for objective scoring); Writing/Speaking exams omit it since those are graded by the AI against the band rubric.',
  })
  @ApiEnvelopeResponse(IeltsExam, {
    isArray: true,
    description: 'Exams for the requested section.',
  })
  listExams(@Query() query: ListExamsQueryDto): Promise<IeltsExam[]> {
    return this.ieltsService.listExams(query.section, query.limit);
  }

  @Get('exams/:id')
  @ApiOperation({
    summary: 'Get an exam by id',
    description:
      'Returns a single exam with its full list of questions. Note the response includes each question’s `answerKey` for objectively scored sections; productive-section exams (writing/speaking) have no answer key.',
  })
  @ApiParam({
    name: 'id',
    description: 'Exam id.',
    example: 'exam-listening-001',
  })
  @ApiEnvelopeResponse(IeltsExam, { description: 'The requested exam.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'No exam exists with the given id.',
  })
  getExam(@Param('id') id: string): Promise<IeltsExam> {
    return this.ieltsService.getExam(id);
  }

  @Post('attempts')
  @ApiOperation({
    summary: 'Start an attempt',
    description:
      'Creates a fresh attempt for the caller against the given exam. The new attempt starts with empty `responses` and status `in_progress`; its `section` is copied from the exam. 404s if the exam does not exist. This begins the lifecycle: `in_progress` → `submitted` → `scored`.',
  })
  @ApiEnvelopeResponse(IeltsAttempt, {
    created: true,
    description: 'The newly created attempt.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'No exam exists with the given `examId`.',
  })
  startAttempt(
    @CurrentUser('uid') uid: string,
    @Body() dto: StartAttemptDto,
  ): Promise<IeltsAttempt> {
    return this.ieltsService.startAttempt(uid, dto.examId);
  }

  @Get('attempts')
  @ApiOperation({
    summary: 'List my attempts',
    description:
      'Lists the caller’s own attempts, newest first, capped by `limit`. Only attempts owned by the authenticated user are ever returned.',
  })
  @ApiEnvelopeResponse(IeltsAttempt, {
    isArray: true,
    description: 'The caller’s attempts.',
  })
  listAttempts(
    @CurrentUser('uid') uid: string,
    @Query() query: PaginationQueryDto,
  ): Promise<IeltsAttempt[]> {
    return this.ieltsService.listUserAttempts(uid, query.limit);
  }

  @Patch('attempts/:id/responses')
  @ApiOperation({
    summary: 'Submit answers for an attempt',
    description:
      'Saves the learner’s answers (keyed by question id) and moves the attempt to `submitted`, recording `submittedAt`. May be called repeatedly to overwrite answers until the attempt is scored. 404s if the attempt does not exist, 403s if the caller does not own it, and 409s if it has already been scored.',
  })
  @ApiParam({
    name: 'id',
    description: 'Attempt id (UUID).',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  @ApiEnvelopeResponse(IeltsAttempt, {
    description: 'The attempt with saved answers, now `submitted`.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'No attempt exists with the given id.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'You do not own this attempt.',
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Attempt already scored.',
  })
  submitResponses(
    @CurrentUser('uid') uid: string,
    @Param('id') id: string,
    @Body() dto: SubmitResponsesDto,
  ): Promise<IeltsAttempt> {
    return this.ieltsService.submitResponses(id, uid, dto.responses);
  }

  @Post('attempts/:id/score')
  @ApiOperation({
    summary: 'Score an attempt',
    description:
      'Grades the attempt and moves it to `scored`, recording `scoredAt` and populating `result`. Scoring splits by section: Listening and Reading are auto-scored against the exam’s answer key with NO LLM call, yielding `correctCount`/`total` plus a band. Writing and Speaking are graded by the AI against the official IELTS band-descriptor rubric, returning a per-criterion breakdown (`criteria`) plus an overall band. 404s if the attempt does not exist, 403s if the caller does not own it, and 409s if it has already been scored.',
  })
  @ApiParam({
    name: 'id',
    description: 'Attempt id (UUID).',
    example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  })
  @ApiEnvelopeResponse(IeltsAttempt, {
    description: 'The scored attempt with its band result.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'No attempt exists with the given id.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'You do not own this attempt.',
  })
  scoreAttempt(
    @CurrentUser('uid') uid: string,
    @Param('id') id: string,
  ): Promise<IeltsAttempt> {
    return this.ieltsService.scoreAttempt(id, uid);
  }
}
