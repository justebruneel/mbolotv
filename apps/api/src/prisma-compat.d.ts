import '@prisma/client';

declare module '@prisma/client' {
  namespace Prisma {
    type InputJsonValue = any;
    type ChannelUpdateInput = any;
  }
}
