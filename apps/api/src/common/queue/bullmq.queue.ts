import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobHandler, JobQueue, QueueJob } from './queue.interface';
import { Queue, Worker } from 'bullmq';

@Injectable()
export class BullmqJobQueue implements JobQueue {
  private readonly queue: Queue;
  private readonly redisUrl: string;
  private worker: Worker | null = null;

  constructor(config: ConfigService) {
    this.redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.queue = new Queue('mbolo-jobs', { connection: { url: this.redisUrl } });
  }

  async enqueue(name: string, payload: Record<string, unknown>): Promise<void> {
    await this.queue.add(name, payload);
  }

  async process(handler: JobHandler): Promise<void> {
    this.worker = new Worker(
      'mbolo-jobs',
      async (job) => {
        const queueJob: QueueJob = {
          id: job.id ?? randomUUID(),
          name: job.name,
          payload: job.data as Record<string, unknown>,
          attemptsMade: job.attemptsMade,
        };
        await handler(queueJob);
      },
      { connection: { url: this.redisUrl }, concurrency: 1 },
    );
    await this.worker.waitUntilReady();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
