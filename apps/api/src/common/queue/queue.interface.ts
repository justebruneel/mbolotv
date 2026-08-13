export interface QueueJob {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  attemptsMade?: number;
}

export interface JobHandler {
  (job: QueueJob): Promise<void>;
}

export abstract class JobQueue {
  abstract enqueue(name: string, payload: Record<string, unknown>): Promise<void>;
  abstract process(handler: JobHandler): Promise<void>;
  abstract close(): Promise<void>;
}
