import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firestore/firestore.constants';

/**
 * Liveness probe for Firestore. Issues a cheap, bounded read so orchestrators
 * (Cloud Run / k8s) can tell whether the process can actually reach its
 * database (micro-use-health-checks).
 */
@Injectable()
export class FirestoreHealthIndicator {
  constructor(
    @Inject(FIRESTORE) private readonly firestore: Firestore,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string) {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.firestore.listCollections();
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    }
  }
}
