import {
  Body,
  Controller,
  Delete,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuthenticatedPrincipal } from '../common/interfaces/authenticated-principal.interface';
import { ApiEnvelopeResponse } from '../common/swagger/api-envelope';
import { ErrorResponseDto } from '../common/swagger/error-response.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { IceServers } from './entities/ice-servers.entity';
import { InviteEmailsDto } from './dto/invite-emails.dto';
import { JoinRoomDto } from './dto/join-room.dto';
import { PostTranscriptDto } from './dto/post-transcript.dto';
import { HostMessage } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

const ROOM_ID_PARAM = {
  name: 'id',
  description: 'Room id (UUID).',
  example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
} as const;

const NOT_INVITED_RESPONSE = {
  type: ErrorResponseDto,
  description:
    'The caller is neither the owner nor invited (rooms are invite-only), or has not joined yet where a seat is required.',
} as const;

const OWNER_ONLY_RESPONSE = {
  type: ErrorResponseDto,
  description: 'Only the room owner may manage invites.',
} as const;

/**
 * REST surface for rooms. Every route is behind the global GoogleAuthGuard,
 * so the caller's uid and email always come from the verified token (never the
 * body) — the invite-only access rules live in the service. Realtime voice flows over
 * the Socket.IO `rooms` namespace; these endpoints own persistence, the manual
 * topic change, and reads.
 */
@ApiTags('Rooms')
@ApiBearerAuth('google')
@ApiUnauthorizedResponse({
  description: 'Missing, malformed, or invalid Google ID token.',
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
      'Opens a new practice room owned by the caller. The room starts in `waiting` status with the owner as its sole participant. `maxParticipants` (default 5) and `durationMinutes` (10, 15, 30, 45 or 60; default 30) may be omitted. Set `hostPicksTopic: true` to let the AI host choose the opening topic — `topic` is then optional and ignored, and the call fails with 503 if the AI is unavailable. Once open, the host stays quiet until people begin talking.',
  })
  @ApiEnvelopeResponse(Room, {
    created: true,
    description: 'The created room.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description:
      'The AI host could not pick an opening topic (only when `hostPicksTopic` is true).',
  })
  create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: CreateRoomDto,
  ): Promise<Room> {
    return this.roomsService.createRoom(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List my open rooms',
    description:
      'Returns the `waiting` or `live` rooms the caller owns or is invited to, newest first — other people’s rooms never appear. `ended` rooms are excluded. Use `limit` to cap the page size.',
  })
  @ApiEnvelopeResponse(Room, {
    isArray: true,
    description: 'The caller’s open (waiting/live) rooms, newest first.',
  })
  listOpen(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<Room[]> {
    return this.roomsService.listRoomsFor(user, query.limit);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a room',
    description:
      'Fetches a single room by id in any lifecycle state (including `ended`, where the `report` is present). Owner or invitees only (403 otherwise); `invitedEmails` and `inviteCode` are returned to the owner only. Returns 404 if no room with that id exists.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The requested room.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  getOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<Room> {
    return this.roomsService.getRoomFor(id, user);
  }

  @Post(':id/join')
  @ApiOperation({
    summary: 'Join a room',
    description:
      'Adds the caller to the room’s participants and pushes the updated room to everyone already in it as a `roomUpdated` socket event. Idempotent — already-joined callers get the room unchanged. Fails with 409 if the room has ended or is at `maxParticipants`, and 404 if it does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The room including the caller.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Room is full or already ended.',
  })
  async join(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: JoinRoomDto,
  ): Promise<Room> {
    const room = await this.roomsService.joinRoom(id, uid);
    this.roomsGateway.broadcastRoomUpdated(room);
    return room;
  }

  @Post(':id/leave')
  @ApiOperation({
    summary: 'Leave a room',
    description:
      'Removes the caller from the room’s participants and pushes the updated room to everyone still in it as a `roomUpdated` socket event. Idempotent. The room is not deleted even if it becomes empty. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The room without the caller.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  async leave(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<Room> {
    const room = await this.roomsService.leaveRoom(id, uid);
    this.roomsGateway.broadcastRoomUpdated(room);
    return room;
  }

  @Post(':id/start')
  @ApiOperation({
    summary: 'Start a room',
    description:
      'Transitions a `waiting` room to `live`, stamps `startedAt` and `scheduledEndAt` (= start + `durationMinutes`) and starts the clock: the session ends automatically at `scheduledEndAt` — report generated, `sessionEnded` emitted — unless the owner ends it first. Everyone in the room receives the now-live room (with `scheduledEndAt`) as a `roomUpdated` socket event. The host says nothing yet; it only steps in once people have talked. Owner-only (non-owners get 403). Returns 409 if the room has already started or has ended, and 404 if it does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The now-live room.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'Only the room owner may start/end the room.',
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Room has already started or has ended.',
  })
  async start(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    const room = await this.roomsService.startRoom(id, uid);
    this.roomsGateway.scheduleSessionEnd(room);
    this.roomsGateway.broadcastRoomUpdated(room);
    return room;
  }

  @Post(':id/end')
  @ApiOperation({
    summary: 'End a room (and generate its report)',
    description:
      'Ends the session now instead of waiting for `scheduledEndAt`: transitions the room to `ended`, stamps `endedAt`, and generates the single room-level report (summary, highlights, suggestions, topics explored) from the full conversation including the host’s topic changes — returned on the room’s `report` field and pushed to participants as a `sessionEnded` socket event. Report generation is best-effort: if the AI is unavailable the room still ends, without a report. Owner-only (non-owners get 403). Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, {
    description: 'The ended room, including its report when available.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
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
      'Returns the room’s most recent voice-transcript segments (speech-to-text), oldest first. Owner or invitees only (403 otherwise). `limit` caps how many of the latest are returned. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TranscriptSegment, {
    isArray: true,
    description: 'Transcript segments, oldest first.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  getTranscript(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<TranscriptSegment[]> {
    return this.roomsService.listTranscript(id, user, query.limit);
  }

  @Post(':id/transcript')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a transcript segment',
    description:
      'Persists one transcript segment spoken by the caller — a REST alternative to the realtime `transcript` socket event, useful for testing and non-socket clients. Does not itself consult the host (auto-triggers run in the gateway). Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TranscriptSegment, {
    created: true,
    description: 'The stored transcript segment.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  addTranscript(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: PostTranscriptDto,
  ): Promise<TranscriptSegment> {
    return this.roomsService.addTranscriptSegment(
      id,
      { uid: user.uid, email: user.email, name: dto.speakerName ?? user.name },
      dto.text,
    );
  }

  @Post(':id/change-topic')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Make the host change the topic now (manual override)',
    description:
      'Forces the AI host to step in immediately: it listens to the recent conversation and says a line that moves the room onto a completely different topic — for when the group wants a fresh subject or did not like the current one. Unlike the automatic in-session checks (where the host only speaks when it judges the current topic has been talked about enough or the room has gone quiet), this always produces a host message. The message is stored, pushed to participants as a `hostMessage` socket event, and returned. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(HostMessage, {
    created: true,
    description: 'What the host said.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  async changeTopic(@Param('id') id: string): Promise<HostMessage> {
    const message = await this.roomsService.forceTopicChange(id);
    this.roomsGateway.broadcastHostMessage(message);
    return message;
  }

  @Get(':id/host-messages')
  @ApiOperation({
    summary: 'List what the host has said',
    description:
      'Returns the AI host’s lines in this room — every topic change it announced — oldest first. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(HostMessage, {
    isArray: true,
    description: 'Host messages, oldest first.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  getHostMessages(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<HostMessage[]> {
    return this.roomsService.listHostMessages(id, query.limit);
  }
}
