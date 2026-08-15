import { ConfigService } from '@nestjs/config';
import { InMemoryStreamSessionStore } from './stream-session.store';

function createStore() {
  const config = {
    get: (_key: string, fallback: number) => fallback,
  } as unknown as ConfigService;
  return new InMemoryStreamSessionStore(config);
}

describe('InMemoryStreamSessionStore', () => {
  it('crée et récupère une session avec TTL', () => {
    const store = createStore();
    const session = store.create(
      {
        channelId: 'ch1',
        variantId: 'v1',
        sourceId: 's1',
        providerHostname: 'provider.example.com',
      },
      60_000,
      3_600_000,
    );

    expect(store.get(session.id)).toBeDefined();
    expect(store.get(session.id)?.providerHostname).toBe('provider.example.com');
  });

  it('expire une session inactivée au-delà du TTL glissant', () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = store.create(
        { channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' },
        1_000,
        3_600_000,
      );

      store.touch(session.id, 1_000);
      jest.advanceTimersByTime(1_001);
      expect(store.get(session.id)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('le touch glissant prolonge la session', () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = store.create(
        { channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' },
        10_000,
        3_600_000,
      );
      jest.advanceTimersByTime(9_000);
      store.touch(session.id, 10_000);
      jest.advanceTimersByTime(9_000);
      expect(store.get(session.id)).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('le plafond absolu expire la session même active', () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = store.create(
        { channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' },
        10_000,
        5_000,
      );
      store.touch(session.id, 10_000);
      jest.advanceTimersByTime(5_001);
      expect(store.get(session.id)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('gère les alias avec TTL propre', () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = store.create(
        { channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' },
        60_000,
        3_600_000,
      );
      store.addAlias(session.id, 'master', 'https://provider.example.com/a.m3u8', 6_000);
      expect(store.getAlias(session.id, 'master')).toBe(
        'https://provider.example.com/a.m3u8',
      );
      jest.advanceTimersByTime(6_001);
      expect(store.getAlias(session.id, 'master')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('prune les sessions et alias expirés', () => {
    jest.useFakeTimers();
    try {
      const store = createStore();
      const session = store.create(
        { channelId: 'ch1', variantId: 'v1', sourceId: 's1', providerHostname: 'h' },
        1_000,
        3_600_000,
      );
      store.addAlias(session.id, 'a', 'https://provider.example.com/a', 1_000);
      jest.advanceTimersByTime(1_001);
      store.prune();
      expect(store.get(session.id)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
