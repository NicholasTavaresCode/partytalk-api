import { HostMessage } from './entities/host-message.entity';
import { Room } from './entities/room.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';

/**
 * Persistence contract for rooms, their voice-transcript stream and the lines
 * the AI host said. Abstracted from Firestore so the service is unit-testable
 * with an in-memory fake (arch-use-repository-pattern). Used as a DI token via
 * `useClass`.
 */
export abstract class RoomsRepository {
  abstract findById(id: string): Promise<Room | null>;
  abstract create(room: Room): Promise<Room>;
  abstract update(
    id: string,
    changes: Partial<Omit<Room, 'id' | 'createdAt'>>,
  ): Promise<Room | null>;
  abstract delete(id: string): Promise<void>;

  /**
   * Open rooms (status `waiting` or `live`) the user owns or whose invite list
   * holds `email` (already normalized), newest first.
   */
  abstract listOpenForMember(
    uid: string,
    email: string | undefined,
    limit: number,
  ): Promise<Room[]>;

  abstract addSegment(segment: TranscriptSegment): Promise<TranscriptSegment>;

  /** The first `limit` transcript segments of a room, oldest first. */
  abstract listSegments(
    roomId: string,
    limit: number,
  ): Promise<TranscriptSegment[]>;

  /**
   * The `limit` MOST RECENT transcript segments of a room, still in
   * chronological order — the window the host listens to on each turn.
   */
  abstract listRecentSegments(
    roomId: string,
    limit: number,
  ): Promise<TranscriptSegment[]>;

  abstract addHostMessage(message: HostMessage): Promise<HostMessage>;

  /** Everything the host has said in a room, oldest first. */
  abstract listHostMessages(
    roomId: string,
    limit: number,
  ): Promise<HostMessage[]>;
}
