import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JobHandler, JobQueue, QueueJob } from './queue.interface';

const MAX_ATTEMPTS = 3;

@Injectable()
export class InProcessJobQueue implements JobQueue {
  private handler: JobHandler | null = null;
  private readonly pending: QueueJob[] = [];
  private running = false;
  async enqueue(name: string, payload: Record<string, unknown>): Promise<void> { this.pending.push({ id: randomUUID(), name, payload, attemptsMade: 0 }); void this.drain(); }
  async process(handler: JobHandler): Promise<void> { this.handler = handler; void this.drain(); }
  async close(): Promise<void> { this.handler = null; }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      const job = this.pending.shift()!;
      try {
        await this.handler?.(job);
      } catch (error) {
        const attempts = (job.attemptsMade ?? 0) + 1;
        if (attempts < MAX_ATTEMPTS) {
          this.pending.push({ ...job, attemptsMade: attempts });
          await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
        } else {
          console.error(`[queue] job ${job.name} failed after ${attempts} attempts`, error);
        }
      }
    }
    this.running = false;
  }
}
