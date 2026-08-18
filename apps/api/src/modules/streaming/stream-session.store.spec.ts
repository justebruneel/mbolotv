import { ConfigService } from '@nestjs/config';
import { InMemoryStreamSessionStore } from './stream-session.store';

function createStore() {
  return new InMemoryStreamSessionStore({ get: (_key: string, fallback: number) => fallback } as unknown as ConfigService);
}

describe('InMemoryStreamSessionStore', () => {
  it('crée et récupère une session avec TTL', async () => {
    const store = createStore();
    const session = await store.create({ channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'provider.example.com' }, 60_000, 3_600_000);
    expect(await store.get(session.id)).toMatchObject({ providerHostname: 'provider.example.com' });
  });
  it('expire une session inactivée', async () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = await store.create({ channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' }, 1_000, 3_600_000);
      await store.touch(session.id, 1_000);
      jest.advanceTimersByTime(1_001);
      expect(await store.get(session.id)).toBeUndefined();
    } finally { jest.useRealTimers(); }
  });
  it('prolonge le TTL glissant sans dépasser le plafond absolu', async () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = await store.create({ channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' }, 10_000, 5_000);
      await store.touch(session.id, 10_000);
      jest.advanceTimersByTime(5_001);
      expect(await store.get(session.id)).toBeUndefined();
    } finally { jest.useRealTimers(); }
  });
  it('gère les alias avec TTL', async () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = await store.create({ channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' }, 60_000, 3_600_000);
      await store.addAlias(session.id, 'master', 'https://provider.example.com/a.m3u8', 6_000);
      expect(await store.getAlias(session.id, 'master')).toBe('https://provider.example.com/a.m3u8');
      jest.advanceTimersByTime(6_001);
      expect(await store.getAlias(session.id, 'master')).toBeUndefined();
    } finally { jest.useRealTimers(); }
  });
});
