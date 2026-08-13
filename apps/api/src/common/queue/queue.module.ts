import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullmqJobQueue } from './bullmq.queue';
import { InProcessJobQueue } from './in-process.queue';
import { JobQueue } from './queue.interface';

const queueProvider: Provider = {
  provide: JobQueue,
  useFactory: (config: ConfigService) => {
    const driver = config.get<string>('QUEUE_DRIVER', 'inprocess');
    return driver === 'bullmq' ? new BullmqJobQueue(config) : new InProcessJobQueue();
  },
  inject: [ConfigService],
};

@Module({
  providers: [queueProvider],
  exports: [queueProvider],
})
export class QueueModule {}
