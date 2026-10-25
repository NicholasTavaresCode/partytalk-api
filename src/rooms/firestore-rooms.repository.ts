import { Inject, Injectable } from '@nestjs/common';
import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, FIRESTORE } from '../firestore/firestore.constants';
import { Room, RoomStatus } from './entities/room.entity';
import { TopicSuggestion } from './entities/topic-suggestion.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { RoomsRepository } from './rooms.repository';

const OPEN_STATUSES: RoomStatus[] = ['waiting', 'live'];

/**
 * Firestore-backed RoomsRepository. The document id is the room's id, so
 * lookups are single-document reads. Transcript segments and topic suggestions
 * live in per-room subcollections (`rooms/{id}/segments`, `rooms/{id}/suggestions`)
 * so reads never scan other rooms. All SDK access is confined here; the service
 * stays persistence-agnostic.
 */
@Injectable()
export class FirestoreRoomsRepository extends RoomsRepository {
  constructor(@Inject(FIRESTORE) private readonly firestore: Firestore) {
    super();
  }

  private get collection() {
    return this.firestore.collection(COLLECTIONS.ROOMS);
  }

  private segmentsCollection(roomId: string) {
    return this.collection.doc(roomId).collection(COLLECTIONS.ROOM_SEGMENTS);
  }

  private suggestionsCollection(roomId: string) {
    return this.collection.doc(roomId).collection(COLLECTIONS.ROOM_SUGGESTIONS);
  }

  async findById(id: string): Promise<Room | null> {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? (snapshot.data() as Room) : null;
  }

  async create(room: Room): Promise<Room> {
    await this.collection.doc(room.id).set(room);
    return room;
  }

  async update(
    id: string,
    changes: Partial<Omit<Room, 'id' | 'createdAt'>>,
  ): Promise<Room | null> {
    const ref = this.collection.doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return null;
    }
    await ref.set(changes, { merge: true });
    const updated = await ref.get();
    return updated.data() as Room;
  }

  async delete(id: string): Promise<void> {
    await this.collection.doc(id).delete();
  }

  async listOpenForMember(
    uid: string,
    email: string | undefined,
    limit: number,
  ): Promise<Room[]> {
    // Two single-field queries (no composite index needed), merged in memory.
    // A user's rooms + invitations are few, so the status filter is cheap here.
    const queries = [this.collection.where('ownerId', '==', uid).get()];
    if (email) {
      queries.push(
        this.collection.where('invitedEmails', 'array-contains', email).get(),
      );
    }
    const byId = new Map<string, Room>();
    for (const snapshot of await Promise.all(queries)) {
      for (const doc of snapshot.docs) {
        byId.set(doc.id, doc.data() as Room);
      }
    }
    return [...byId.values()]
      .filter((room) => OPEN_STATUSES.includes(room.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async addSegment(segment: TranscriptSegment): Promise<TranscriptSegment> {
    await this.segmentsCollection(segment.roomId).doc(segment.id).set(segment);
    return segment;
  }

  async listSegments(
    roomId: string,
    limit: number,
  ): Promise<TranscriptSegment[]> {
    // Newest `limit` first from Firestore, then flipped back to chronological.
    const snapshot = await this.segmentsCollection(roomId)
      .orderBy('at', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs
      .map((doc) => doc.data() as TranscriptSegment)
      .reverse();
  }

  async countSegments(roomId: string): Promise<number> {
    const snapshot = await this.segmentsCollection(roomId).count().get();
    return snapshot.data().count;
  }

  async addSuggestion(suggestion: TopicSuggestion): Promise<TopicSuggestion> {
    await this.suggestionsCollection(suggestion.roomId)
      .doc(suggestion.id)
      .set(suggestion);
    return suggestion;
  }

  async listSuggestions(
    roomId: string,
    limit: number,
  ): Promise<TopicSuggestion[]> {
    const snapshot = await this.suggestionsCollection(roomId)
      .orderBy('at', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as TopicSuggestion).reverse();
  }
}
