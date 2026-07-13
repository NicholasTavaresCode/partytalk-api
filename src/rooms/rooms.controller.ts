import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import { ApiEnvelopeResponse } from '../common/swagger/api-envelope';
import { ErrorResponseDto } from '../common/swagger/error-response.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { PostTranscriptDto } from './dto/post-transcript.dto';
import { Room } from './entities/room.entity';
import { TopicSuggestion } from './entities/topic-suggestion.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

const ROOM_ID_PARAM = {
  name: 'id',
  description: 'Room id (UUID).',
  example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
} as const;

/**
 * REST surface for rooms. Every route is behind the global FirebaseAuthGuard,
 * so the caller's uid always comes from the verified token (never the body) —
 * ownership/participation checks live in the service. Realtime voice flows over
 * the Socket.IO `rooms` namespace; these endpoints own persistence, the manual
 * facilitator trigger, and reads.
 */
@ApiTags('Rooms')
@ApiBearerAuth('firebase')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or expired Firebase token.',
  type: ErrorResponseDto,
})
@Controller({ path: 'rooms', version: '1' })
export class RoomsController {
  constructor(
    private readonly roomsService: RoomsService,
    private readonly roomsGateway: RoomsGateway,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a room',
    description:
      'Opens a new practice room owned by the caller. The room starts in `waiting` status with the owner as its sole participant. `facilitatorPersona` and `maxParticipants` default when omitted. The AI facilitator stays silent until people begin talking.',
  })
  @ApiEnvelopeResponse(Room, { created: true, description: 'The created room.' })
  create(
    @CurrentUser('uid') uid: string,
    @Body() dto: CreateRoomDto,
  ): Promise<Room> {
    return this.roomsService.createRoom(uid, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List open rooms',
    description:
      'Returns rooms still joinable — `waiting` or `live` — ordered newest first. `ended` rooms are excluded. Use `limit` to cap the page size.',
  })
  @ApiEnvelopeResponse(Room, {
    isArray: true,
    description: 'Open (waiting/live) rooms, newest first.',
  })
  listOpen(@Query() query: PaginationQueryDto): Promise<Room[]> {
    return this.roomsService.listOpenRooms(query.limit);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a room',
    description:
      'Fetches a single room by id in any lifecycle state (including `ended`, where the `report` is present). Returns 404 if no room with that id exists.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The requested room.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  getOne(@Param('id') id: string): Promise<Room> {
    return this.roomsService.getRoom(id);
  }

  @Post(':id/join')
  @ApiOperation({
    summary: 'Join a room',
    description:
      'Adds the caller to the room’s participants. Idempotent — already-joined callers get the room unchanged. Fails with 409 if the room has ended or is at `maxParticipants`, and 404 if it does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The room including the caller.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Room is full or already ended.',
  })
  join(@Param('id') id: string, @CurrentUser('uid') uid: string): Promise<Room> {
    return this.roomsService.joinRoom(id, uid);
  }

  @Post(':id/leave')
  @ApiOperation({
    summary: 'Leave a room',
    description:
      'Removes the caller from the room’s participants. Idempotent. The room is not deleted even if it becomes empty. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The room without the caller.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  leave(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    return this.roomsService.leaveRoom(id, uid);
  }

  @Post(':id/start')
  @ApiOperation({
    summary: 'Start a room',
    description:
      'Transitions the room to `live` so transcript ingestion and facilitator nudges begin. No AI turn is produced yet — the facilitator only reacts once people talk. Owner-only (non-owners get 403). Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The now-live room.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'Only the room owner may start/end the room.',
  })
  start(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    return this.roomsService.startRoom(id, uid);
  }

  @Post(':id/end')
  @ApiOperation({
    summary: 'End a room (and generate its report)',
    description:
      'Transitions the room to `ended`, stamps `endedAt`, and generates the single room-level report (highlights + suggestions) from the full transcript — returned on the room’s `report` field and pushed to participants as a `sessionEnded` socket event. Report generation is best-effort: if the AI is unavailable the room still ends, without a report. Owner-only (non-owners get 403). Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, {
    description: 'The ended room, including its report when available.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'Only the room owner may start/end the room.',
  })
  async end(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    const room = await this.roomsService.endRoom(id, uid);
    this.roomsGateway.broadcastSessionEnded(room.id, room.report);
    return room;
  }

  @Get(':id/transcript')
  @ApiOperation({
    summary: 'Get the transcript',
    description:
      'Returns the room’s voice-transcript segments (speech-to-text), oldest first. Use `limit` to cap the number returned. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TranscriptSegment, {
    isArray: true,
    description: 'Transcript segments, oldest first.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  getTranscript(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<TranscriptSegment[]> {
    return this.roomsService.listTranscript(id, query.limit);
  }

  @Post(':id/transcript')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a transcript segment',
    description:
      'Persists one transcript segment spoken by the caller — a REST alternative to the realtime `transcript` socket event, useful for testing and non-socket clients. Does not itself trigger a suggestion (auto-triggers run in the gateway). Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TranscriptSegment, {
    created: true,
    description: 'The stored transcript segment.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  addTranscript(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PostTranscriptDto,
  ): Promise<TranscriptSegment> {
    return this.roomsService.addTranscriptSegment(
      id,
      { uid: user.uid, name: dto.speakerName ?? user.name },
      dto.text,
    );
  }

  @Post(':id/suggest-topic')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Suggest a topic now (manual trigger)',
    description:
      'Forces the AI facilitator to read the recent transcript and produce one new, related topic immediately — the same engine the automatic volume/silence triggers use. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TopicSuggestion, {
    created: true,
    description: 'The generated topic suggestion.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  suggestTopic(@Param('id') id: string): Promise<TopicSuggestion> {
    return this.roomsService.generateTopicSuggestion(id, 'manual');
  }

  @Get(':id/suggestions')
  @ApiOperation({
    summary: 'List topic suggestions',
    description:
      'Returns the AI facilitator’s topic suggestions for the room, oldest first. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TopicSuggestion, {
    isArray: true,
    description: 'Topic suggestions, oldest first.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Room not found.' })
  getSuggestions(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<TopicSuggestion[]> {
    return this.roomsService.listSuggestions(id, query.limit);
  }
}
