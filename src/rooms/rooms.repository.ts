import { Room } from './entities/room.entity';
import { TopicSuggestion } from './entities/topic-suggestion.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';

/**
 * Persistence contract for rooms, their voice-transcript stream and the AI's
 * topic suggestions. Abstracted from Firestore so the service is unit-testable
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

  /** Rooms still open to join (status `waiting` or `live`), newest first. */
  abstract listOpen(limit: number): Promise<Room[]>;

  abstract addSegment(segment: TranscriptSegment): Promise<TranscriptSegment>;

  /** A room's transcript segments in chronological order (oldest first). */
  abstract listSegments(
    roomId: string,
    limit: number,
  ): Promise<TranscriptSegment[]>;

  /** Total number of transcript segments captured for a room. */
  abstract countSegments(roomId: string): Promise<number>;

  abstract addSuggestion(suggestion: TopicSuggestion): Promise<TopicSuggestion>;

  /** A room's topic suggestions in chronological order (oldest first). */
  abstract listSuggestions(
    roomId: string,
    limit: number,
  ): Promise<TopicSuggestion[]>;
}
