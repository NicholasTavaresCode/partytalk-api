import { Module } from '@nestjs/common';
import { AttemptsRepository } from './attempts.repository';
import { ExamsRepository } from './exams.repository';
import { FirestoreAttemptsRepository } from './firestore-attempts.repository';
import { FirestoreExamsRepository } from './firestore-exams.repository';
import { IeltsController } from './ielts.controller';
import { IeltsService } from './ielts.service';

/**
 * Feature module for the SOLO IELTS exam simulator (arch-feature-modules). Binds
 * the abstract repository tokens to their Firestore implementations and depends
 * on LlmProvider (from AiModule) for rubric scoring. Exports IeltsService for
 * other features to reuse.
 */
@Module({
  controllers: [IeltsController],
  providers: [
    IeltsService,
    { provide: ExamsRepository, useClass: FirestoreExamsRepository },
    { provide: AttemptsRepository, useClass: FirestoreAttemptsRepository },
  ],
  exports: [IeltsService],
})
export class IeltsModule {}
