import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { FirestoreHealthIndicator } from './firestore.health';

/**
 * Health endpoints for orchestration and uptime checks. Public (unauthenticated)
 * and deliberately un-versioned so probes have a stable URL.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly firestore: FirestoreHealthIndicator,
  ) {}

  /** Liveness — the process is up and responding. */
  @Public()
  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 as long as the process is up. No dependencies are checked. Public.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { status: { type: 'string', example: 'ok' } },
    },
  })
  live() {
    return { status: 'ok' };
  }

  /** Readiness — dependencies (Firestore) are reachable. */
  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Returns 200 when dependencies (Firestore) are reachable, 503 otherwise. Public. Use for load-balancer/orchestrator readiness gating.',
  })
  ready() {
    return this.health.check([() => this.firestore.isHealthy('firestore')]);
  }
}
