import {
  createNavigator,
  markVisitedStops,
  rerouteRequest,
  simulateDrive,
  type FinishTripResponse,
  type NavFix,
  type NavState,
  type Navigator,
  type PlanResponse,
  type Route,
  type TraceSample,
  type TripStop,
} from '@wayboo/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import { create } from 'zustand';
import { api } from './api';
import { useLocationStore } from './location';
import { useSettings } from './store';

type Status = 'idle' | 'navigating' | 'arrived';

interface NavSession {
  status: Status;
  plan: PlanResponse | null;
  route: Route | null;
  /** Paradas do plano original; as visitadas não voltam nos recálculos. */
  stops: TripStop[];
  nav: NavState | null;
  tripId: string | null;
  simulated: boolean;
  rerouting: boolean;
  muted: boolean;
  result: FinishTripResponse | null;
  error: string | null;
}

export const useNavSession = create<NavSession>(() => ({
  status: 'idle',
  plan: null,
  route: null,
  stops: [],
  nav: null,
  tripId: null,
  simulated: false,
  rerouting: false,
  muted: false,
  result: null,
  error: null,
}));

const KEEP_AWAKE_TAG = 'wayboo-nav';
const SIM_SPEEDUP = 6;
const FLUSH_EVERY_MS = 15_000;

let navigator: Navigator | null = null;
let unsubscribe: (() => void) | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let buffer: TraceSample[] = [];
let lastRerouteAt = 0;
let finishing = false;
let keepAwakeActive = false;
let keepAwakeQueue: Promise<void> = Promise.resolve();

/**
 * Serializa ativar e desativar o wake lock: parar antes de a ativação terminar não deixa a tela presa acesa.
 * Falhas são ignoradas (web sem a API, HTTP fora de localhost, aba oculta): a navegação segue e só a tela pode apagar.
 */
function queueKeepAwake(op: () => Promise<void>) {
  keepAwakeQueue = keepAwakeQueue.then(op).catch(() => {});
}

function acquireKeepAwake() {
  queueKeepAwake(async () => {
    if (keepAwakeActive) return;
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    keepAwakeActive = true;
  });
}

function releaseKeepAwake() {
  queueKeepAwake(async () => {
    // Na web, desativar uma tag que não está ativa lança ERR_KEEP_AWAKE_TAG_INVALID.
    if (!keepAwakeActive) return;
    // Só marca inativo após sucesso: se falhar, a próxima liberação tenta de novo.
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    keepAwakeActive = false;
  });
}

function speak(text: string) {
  const { voice } = useSettings.getState();
  if (!voice || useNavSession.getState().muted) return;
  Speech.stop();
  Speech.speak(text, { language: 'pt-BR', rate: 1.02 });
}

async function flush() {
  const { tripId } = useNavSession.getState();
  if (!tripId || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await api.samples(tripId, batch);
  } catch {
    // Sem rede: devolve ao buffer para a próxima tentativa (limite para não crescer sem fim).
    buffer = [...batch, ...buffer].slice(-5000);
  }
}

function cleanup() {
  unsubscribe?.();
  unsubscribe = null;
  if (simTimer) clearInterval(simTimer);
  if (flushTimer) clearInterval(flushTimer);
  simTimer = null;
  flushTimer = null;
  navigator = null;
  Speech.stop();
  releaseKeepAwake();
}

async function reroute(fix: NavFix) {
  const s = useNavSession.getState();
  if (!s.plan || s.rerouting) return;
  lastRerouteAt = Date.now();
  useNavSession.setState({ rerouting: true });
  speak('Recalculando rota');
  try {
    const { avoidTolls, avoidHighways } = useSettings.getState();
    const next = await api.plan(rerouteRequest(s.plan, fix, s.stops, { avoidTolls, avoidHighways, avoidFerries: false }));
    const chosen = next.routes[next.recommendedIndex]!;
    navigator = createNavigator(chosen.route, { segmentDurationsS: chosen.eta.segmentDurationsS });
    if (s.tripId) await api.reroute(s.tripId, next.planId, next.recommendedIndex);
    useNavSession.setState({ route: chosen.route, plan: { ...next, destination: s.plan.destination }, rerouting: false });
  } catch (e) {
    useNavSession.setState({ rerouting: false, error: e instanceof Error ? e.message : 'Falha ao recalcular' });
  }
}

function onFix(fix: NavFix) {
  if (!navigator || finishing) return;
  const st = navigator.update(fix);
  const s = useNavSession.getState();
  const stops = markVisitedStops(s.stops, fix);
  useNavSession.setState(stops === s.stops ? { nav: st } : { nav: st, stops });
  if (st.announcement) speak(st.announcement);
  if (!s.simulated) buffer.push({ t: fix.t, lat: fix.lat, lon: fix.lon, speed: fix.speed ?? null, heading: fix.heading ?? null, accuracy: fix.accuracy ?? null });
  if (st.arrived) {
    void stopNavigation();
    return;
  }
  if (st.offRoute && !s.rerouting && Date.now() - lastRerouteAt > 12_000) void reroute(fix);
}

export async function startNavigation(plan: PlanResponse, routeIndex: number, simulate: boolean): Promise<void> {
  cleanup();
  finishing = false;
  buffer = [];
  const chosen = plan.routes[routeIndex];
  if (!chosen) return;
  navigator = createNavigator(chosen.route, { segmentDurationsS: chosen.eta.segmentDurationsS });
  useNavSession.setState({
    status: 'navigating',
    plan,
    route: chosen.route,
    stops: plan.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, visited: false })),
    nav: null,
    tripId: null,
    simulated: simulate,
    rerouting: false,
    result: null,
    error: null,
  });
  acquireKeepAwake();

  if (simulate) {
    // Simulação não grava viagem: o tempo é acelerado e ensinaria durações falsas ao modelo.
    const gen = simulateDrive(chosen.route, chosen.eta.segmentDurationsS, Date.now(), 1, 3);
    simTimer = setInterval(() => {
      const next = gen.next();
      if (next.done) {
        void stopNavigation();
        return;
      }
      useLocationStore.setState({ fix: next.value });
      onFix(next.value);
    }, 1000 / SIM_SPEEDUP);
    return;
  }

  try {
    const { tripId } = await api.startTrip(plan.planId, routeIndex);
    useNavSession.setState({ tripId });
  } catch (e) {
    // Sem servidor a navegação continua; só não haverá aprendizado desta viagem.
    useNavSession.setState({ error: e instanceof Error ? e.message : 'Viagem não registrada' });
  }
  flushTimer = setInterval(() => void flush(), FLUSH_EVERY_MS);
  unsubscribe = useLocationStore.subscribe((state, prev) => {
    if (state.fix && state.fix !== prev.fix) onFix(state.fix);
  });
  const current = useLocationStore.getState().fix;
  if (current) onFix(current);
}

export async function stopNavigation(): Promise<void> {
  if (finishing) return;
  finishing = true;
  const { tripId, simulated, nav } = useNavSession.getState();
  cleanup();
  if (simulated || !tripId) {
    useNavSession.setState({ status: nav?.arrived ? 'arrived' : 'idle', result: null });
    return;
  }
  await flush();
  try {
    const result = await api.finishTrip(tripId);
    useNavSession.setState({ status: 'arrived', result });
  } catch (e) {
    useNavSession.setState({ status: 'idle', error: e instanceof Error ? e.message : 'Falha ao encerrar viagem' });
  }
}

export function toggleMute() {
  const muted = !useNavSession.getState().muted;
  if (muted) Speech.stop();
  useNavSession.setState({ muted });
}

export function dismissSession() {
  useNavSession.setState({ status: 'idle', plan: null, route: null, stops: [], nav: null, tripId: null, result: null, error: null });
}
