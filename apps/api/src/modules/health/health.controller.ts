import { Controller, Get, HttpCode, HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/database/prisma.service.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { Public } from '../auth/auth.guard.js';

/**
 * Health endpoints, split by what an orchestrator does with the answer.
 *
 *   /health/live   Is the process alive? Never touches a dependency. A failing
 *                  database must not cause Kubernetes to kill and restart a
 *                  perfectly healthy pod — restarting cannot fix Postgres.
 *
 *   /health/ready  Can this instance serve traffic? Checks dependencies, so a
 *                  pod that cannot reach the database is pulled out of the
 *                  load-balancer rotation while staying alive.
 *
 *   /health        Human-facing summary of both.
 *
 * Conflating the two is a common and expensive mistake: it turns a brief
 * database blip into a cascading restart loop across every replica.
 */
@ApiTags('Health')
// VERSION_NEUTRAL: probes live at /api/health/*, outside the versioned
// surface. An orchestrator's liveness check must not need updating because
// the business API moved to v2.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — process is running' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Public()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe — dependencies reachable' })
  async ready() {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);

    // Redis being down is degradation, not unreadiness: rate limiting and the
    // session cache suffer, but requests are still served correctly from
    // Postgres. Only the database makes an instance genuinely unable to serve.
    const ready = database;

    return {
      status: ready ? 'ok' : 'unavailable',
      checks: {
        database: database ? 'ok' : 'unavailable',
        redis: redis ? 'ok' : 'degraded',
      },
    };
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Combined health summary' })
  async health() {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    return {
      status: database ? 'ok' : 'unavailable',
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database, redis },
    };
  }
}
