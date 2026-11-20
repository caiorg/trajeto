import type { PlanResponse } from '@wayboo/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startNavigation, stopNavigation } from '../src/lib/navigation';

// Imita o expo-keep-awake da web: desativar uma tag inativa lança erro.
const active = new Set<string>();
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: vi.fn(async (tag: string) => {
    active.add(tag);
  }),
  deactivateKeepAwake: vi.fn(async (tag: string) => {
    if (!active.delete(tag)) throw new Error(`The wake lock with tag ${tag} has not activated yet`);
  }),
}));
vi.mock('expo-speech', () => ({ stop: vi.fn(), speak: vi.fn() }));
vi.mock('@wayboo/core', () => ({
  createNavigator: () => ({ update: () => ({ arrived: false, offRoute: false, announcement: null }) }),
  simulateDrive: function* () {},
  markVisitedStops: (stops: unknown) => stops,
  rerouteRequest: () => ({}),
}));
vi.mock('../src/lib/api', () => ({
  api: {
    startTrip: vi.fn(async () => ({ tripId: 't1' })),
    finishTrip: vi.fn(async () => ({})),
    samples: vi.fn(async () => {}),
  },
}));
vi.mock('../src/lib/location', async () => {
  const { create } = await import('zustand');
  return { useLocationStore: create(() => ({ fix: null })) };
});
vi.mock('../src/lib/store', async () => {
  const { create } = await import('zustand');
  return { useSettings: create(() => ({ voice: false, avoidTolls: false, avoidHighways: false })) };
});

const plan = {
  planId: 'p1',
  waypoints: [],
  routes: [{ route: {}, eta: { segmentDurationsS: [] } }],
} as unknown as PlanResponse;

const activate = vi.mocked(activateKeepAwakeAsync);
const deactivate = vi.mocked(deactivateKeepAwake);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  active.clear();
});

afterEach(async () => {
  await stopNavigation();
  await settle();
});

describe('wake lock da navegação', () => {
  it('não desativa a tag quando ela nunca foi ativada', async () => {
    await startNavigation(plan, 0, true);
    await settle();
    expect(deactivate).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(1);
  });

  it('libera o wake lock ao parar', async () => {
    await startNavigation(plan, 0, false);
    await stopNavigation();
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

  it('parar antes de a ativação terminar não deixa a tela presa acesa', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    activate.mockImplementationOnce(async (tag?: string) => {
      await pending;
      active.add(tag!);
    });
    await startNavigation(plan, 0, true);
    await stopNavigation();
    await settle();
    expect(activate).toHaveBeenCalledTimes(1);
    resolve();
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

  it('segue navegando quando o navegador recusa o wake lock', async () => {
    activate.mockRejectedValueOnce(new Error('NotAllowedError'));
    await startNavigation(plan, 0, true);
    await stopNavigation();
    await settle();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('parar e iniciar várias vezes não gera promise rejeitada', async () => {
    for (let i = 0; i < 5; i++) {
      await startNavigation(plan, 0, i % 2 === 0);
      await stopNavigation();
    }
    await settle();
    expect(activate).toHaveBeenCalledTimes(5);
    expect(deactivate).toHaveBeenCalledTimes(5);
    expect(active.size).toBe(0);
  });
});
