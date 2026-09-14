import { Inject, Injectable } from '@nestjs/common';
import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, FIRESTORE } from '../firestore/firestore.constants';
import { HostMessage } from './entities/host-message.entity';
import { Room, RoomStatus } from './entities/room.entity';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { RoomsRepository } from './rooms.repository';

const OPEN_STATUSES: RoomStatus[] = ['waiting', 'live'];

/**
 * Firestore-backed RoomsRepository. The document id is the room's id, so
 * lookups are single-document reads. Transcript segments and the host's lines
 * live in per-room subcollections (`rooms/{id}/segments`,
 * `rooms/{id}/hostMessages`) so reads never scan other rooms. All SDK access is
 * confined here; the service stays persistence-agnostic.
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

  private hostMessagesCollection(roomId: string) {
    return this.collection
      .doc(roomId)
      .collection(COLLECTIONS.ROOM_HOST_MESSAGES);
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

  async listOpen(limit: number): Promise<Room[]> {
    const snapshot = await this.collection
      .where('status', 'in', OPEN_STATUSES)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as Room);
  }

  async addSegment(segment: TranscriptSegment): Promise<TranscriptSegment> {
    await this.segmentsCollection(segment.roomId).doc(segment.id).set(segment);
    return segment;
  }

  async listSegments(
    roomId: string,
    limit: number,
  ): Promise<TranscriptSegment[]> {
    const snapshot = await this.segmentsCollection(roomId)
      .orderBy('at')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as TranscriptSegment);
  }

  async listRecentSegments(
    roomId: string,
    limit: number,
  ): Promise<TranscriptSegment[]> {
    // Newest first to take the tail, then flip back to chronological order.
    const snapshot = await this.segmentsCollection(roomId)
      .orderBy('at', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs
      .map((doc) => doc.data() as TranscriptSegment)
      .reverse();
  }

  async addHostMessage(message: HostMessage): Promise<HostMessage> {
    await this.hostMessagesCollection(message.roomId)
      .doc(message.id)
      .set(message);
    return message;
  }

  async listHostMessages(
    roomId: string,
    limit: number,
  ): Promise<HostMessage[]> {
    const snapshot = await this.hostMessagesCollection(roomId)
      .orderBy('at')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data() as HostMessage);
  }
}
