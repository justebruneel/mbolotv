import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueueJob } from '../../common/queue/queue.interface';
import { ImportProcessor } from './import.processor';

/** Endpoint privé appelé uniquement par le worker BullMQ déployé séparément. */
@Controller('internal/jobs')
export class InternalJobsController {
  constructor(
    private readonly config: ConfigService,
    private readonly imports: ImportProcessor,
  ) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async process(
    @Headers('x-mbolo-worker-secret') secret: string | undefined,
    @Body() job: QueueJob,
  ): Promise<void> {
    const expected = this.config.get<string>('QUEUE_INTERNAL_SECRET');
    if (!expected || secret !== expected) throw new UnauthorizedException('Worker non autorisé');
    if (!job || typeof job.name !== 'string' || !job.payload || typeof job.payload !== 'object') {
      throw new UnauthorizedException('Job invalide');
    }
    await this.imports.handle(job);
  }
}
