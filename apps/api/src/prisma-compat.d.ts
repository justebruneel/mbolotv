declare module '@prisma/client' {
  export type Source = {
    id: string;
    ownerId: string;
    name: string;
    kind: string;
    status: string;
    priority: number;
    connectionEncrypted: Uint8Array;
    lastSyncedAt: Date | null;
    createdAt: Date;
  };

  export namespace Prisma {
    type InputJsonValue = any;
    type ChannelUpdateInput = any;
  }
}
