import { Injectable } from '@nestjs/common';

@Injectable()
export class ImportCancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(importRunId: string): void {
    this.controllers.get(importRunId)?.abort();
    this.controllers.set(importRunId, new AbortController());
  }

  signal(importRunId: string): AbortSignal | undefined { return this.controllers.get(importRunId)?.signal; }

  cancel(importRunId: string): void { this.controllers.get(importRunId)?.abort(); }

  unregister(importRunId: string): void { this.controllers.delete(importRunId); }
}
