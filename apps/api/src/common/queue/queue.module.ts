import { Module, Provider } from '@nestjs/common';
import { InProcessJobQueue } from './in-process.queue';
import { JobQueue } from './queue.interface';

const queueProvider: Provider = {
  provide: JobQueue,
  useFactory: () => new InProcessJobQueue(),
};

@Module({
  providers: [queueProvider],
  exports: [queueProvider],
})
export class QueueModule {}
