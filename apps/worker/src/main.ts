import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';

const queueName = 'mbolo-jobs';
const redisUrl = process.env.REDIS_URL;
const apiUrl = (process.env.WORKER_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const secret = process.env.QUEUE_INTERNAL_SECRET;
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);

if (!redisUrl) throw new Error('REDIS_URL est obligatoire pour le worker');
if (!secret) throw new Error('QUEUE_INTERNAL_SECRET est obligatoire pour le worker');

const worker = new Worker(
  queueName,
  async (job) => {
    const response = await fetch(`${apiUrl}/api/internal/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mbolo-worker-secret': secret },
      body: JSON.stringify({ id: job.id ?? randomUUID(), name: job.name, payload: job.data, attemptsMade: job.attemptsMade }),
    });
    if (!response.ok) throw new Error(`API interne jobs: HTTP ${response.status}`);
  },
  { connection: { url: redisUrl }, concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1 },
);

worker.on('ready', () => console.info('[worker] BullMQ consumer ready'));
worker.on('failed', (job, error) => console.error(`[worker] job ${job?.name ?? 'unknown'} failed`, error));

const shutdown = async (): Promise<void> => {
  await worker.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
