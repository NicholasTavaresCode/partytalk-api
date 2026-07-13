import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { FirestoreHealthIndicator } from './firestore.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [FirestoreHealthIndicator],
})
export class HealthModule {}
