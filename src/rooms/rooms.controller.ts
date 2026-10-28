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
 * facilitator trigger, and reads.
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
      'Opens a new invite-only practice room owned by the caller. The room starts in `waiting` status with the owner as its sole participant; only the owner and the `invitedEmails` can see or join it. `facilitatorPersona` and `maxParticipants` default when omitted. The AI facilitator stays silent until people begin talking.',
  })
  @ApiEnvelopeResponse(Room, {
    created: true,
    description: 'The created room.',
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
      'Adds the caller to the room’s participants. Only the owner and invitees may join — or anyone signed in who presents the room’s current `inviteCode` (from the owner’s invite link), whose email is then added to `invitedEmails`. Idempotent — already-joined callers get the room unchanged. Fails with 403 if not invited, 409 if the room has ended or is at `maxParticipants`, and 404 if it does not exist.',
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
    const room = await this.roomsService.joinRoom(id, user, dto.inviteCode);
    this.roomsGateway.notifyRoomUpdated(id); // the others' tiles come from GET /rooms/:id
    return room;
  }

  @Post(':id/leave')
  @ApiOperation({
    summary: 'Leave a room',
    description:
      'Removes the caller from the room’s participants. Idempotent. The room is not deleted even if it becomes empty. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, { description: 'The room without the caller.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  async leave(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<Room> {
    const room = await this.roomsService.leaveRoom(id, user);
    this.roomsGateway.notifyRoomUpdated(id);
    return room;
  }

  @Post(':id/start')
  @ApiOperation({
    summary: 'Start a room',
    description:
      'Transitions the room to `live` so transcript ingestion and facilitator nudges begin. No AI turn is produced yet — the facilitator only reacts once people talk. Owner-only (non-owners get 403). Returns 404 if the room does not exist.',
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
  async start(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    const room = await this.roomsService.startRoom(id, uid);
    // Participants only enable their mic and voice once they see `live`.
    this.roomsGateway.notifyRoomUpdated(id);
    return room;
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
      'Persists one transcript segment spoken by the caller — a REST alternative to the realtime `transcript` socket event, useful for testing and non-socket clients. Does not itself trigger a suggestion (auto-triggers run in the gateway). Only invited callers who have joined may post (403 otherwise). Returns 404 if the room does not exist.',
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

  @Post(':id/suggest-topic')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Suggest a topic now (manual trigger)',
    description:
      'Forces the AI facilitator to read the recent transcript and produce one new, related topic immediately — the same engine the automatic volume/silence triggers use — and pushes it to everyone in the room as a `topicSuggested` socket event. Owner-only (non-owners get 403): the host steers the conversation, and it spends AI budget. Returns 404 if the room does not exist, 409 if it has ended.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TopicSuggestion, {
    created: true,
    description: 'The generated topic suggestion.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'Only the room owner may ask for a new topic.',
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The room has ended.',
  })
  async suggestTopic(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<TopicSuggestion> {
    const suggestion = await this.roomsService.suggestTopicFor(id, user);
    this.roomsGateway.announceSuggestion(id, suggestion);
    return suggestion;
  }

  @Get(':id/suggestions')
  @ApiOperation({
    summary: 'List topic suggestions',
    description:
      'Returns the AI facilitator’s most recent topic suggestions for the room, oldest first. Owner or invitees only (403 otherwise). `limit` caps how many of the latest are returned. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(TopicSuggestion, {
    isArray: true,
    description: 'Topic suggestions, oldest first.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  getSuggestions(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: PaginationQueryDto,
  ): Promise<TopicSuggestion[]> {
    return this.roomsService.listSuggestions(id, user, query.limit);
  }

  @Get(':id/ice-servers')
  @ApiOperation({
    summary: 'Get ICE servers for voice',
    description:
      'The `RTCConfiguration.iceServers` for the caller’s P2P voice connections in this room: STUN, plus the TURN relay with a credential valid for `ttlSeconds` when a relay is configured. Only invited callers who have joined (403 otherwise), since a TURN credential lets its holder relay traffic through our server. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(IceServers, {
    description: 'ICE servers for this caller.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(NOT_INVITED_RESPONSE)
  getIceServers(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<IceServers> {
    return this.roomsService.iceServersFor(id, user);
  }

  @Post(':id/invites')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Invite people',
    description:
      'Adds emails to the room’s invite list (case-insensitive; already-invited addresses and the owner’s own are ignored). Those Google accounts can then see and join the room. Owner-only. Returns 400 past the invite cap and 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, {
    description: 'The room with its updated invite list.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(OWNER_ONLY_RESPONSE)
  addInvites(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: InviteEmailsDto,
  ): Promise<Room> {
    return this.roomsService.addInvites(id, user, dto.emails);
  }

  @Delete(':id/invites/:email')
  @ApiOperation({
    summary: 'Revoke an invite',
    description:
      'Removes an email from the invite list. If that person has joined, they lose their seat and their live sockets are kicked out of the room and voice call immediately (`removedFromRoom` event). Idempotent. Owner-only. Returns 404 if the room does not exist.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiParam({
    name: 'email',
    description: 'The invited email to revoke.',
    example: 'bo@example.com',
  })
  @ApiEnvelopeResponse(Room, { description: 'The room without that invite.' })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(OWNER_ONLY_RESPONSE)
  async revokeInvite(
    @Param('id') id: string,
    @Param('email') email: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    const { room, removedUids } = await this.roomsService.revokeInvite(
      id,
      uid,
      email,
    );
    await this.roomsGateway.evictFromRoom(id, removedUids, email);
    this.roomsGateway.notifyRoomUpdated(id);
    return room;
  }

  @Post(':id/invite-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create or rotate the invite link',
    description:
      'Mints a fresh `inviteCode` for the shareable link `/practice/{id}?invite={code}`. Anyone signed in who opens it can join and is added to the invite list. Calling again rotates the code, so previously shared links stop working (people already admitted keep access). Owner-only.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, {
    description: 'The room with its new `inviteCode`.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(OWNER_ONLY_RESPONSE)
  createInviteLink(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    return this.roomsService.createInviteLink(id, uid);
  }

  @Delete(':id/invite-link')
  @ApiOperation({
    summary: 'Turn off the invite link',
    description:
      'Clears the `inviteCode` so the shared link no longer admits anyone. People already admitted keep access until revoked. Owner-only.',
  })
  @ApiParam(ROOM_ID_PARAM)
  @ApiEnvelopeResponse(Room, {
    description: 'The room with `inviteCode: null`.',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Room not found.',
  })
  @ApiForbiddenResponse(OWNER_ONLY_RESPONSE)
  disableInviteLink(
    @Param('id') id: string,
    @CurrentUser('uid') uid: string,
  ): Promise<Room> {
    return this.roomsService.disableInviteLink(id, uid);
  }
}
