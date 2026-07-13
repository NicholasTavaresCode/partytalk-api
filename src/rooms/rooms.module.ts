import { Module } from '@nestjs/common';
import { FirestoreRoomsRepository } from './firestore-rooms.repository';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomsRepository } from './rooms.repository';
import { RoomsService } from './rooms.service';

/**
 * Feature module for live practice rooms (arch-feature-modules). Binds the
 * RoomsRepository token to its Firestore implementation and wires the realtime
 * gateway alongside the REST controller. Exports RoomsService so sibling
 * features can reuse room logic without depending on the transport.
 */
@Module({
  controllers: [RoomsController],
  providers: [
    RoomsService,
    RoomsGateway,
    { provide: RoomsRepository, useClass: FirestoreRoomsRepository },
  ],
  exports: [RoomsService],
})
export class RoomsModule {}
