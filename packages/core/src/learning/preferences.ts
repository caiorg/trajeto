import type { EtaEstimate, Route, RouteFeatures } from '../types';

/**
 * Preferência de rota como modelo de escolha (logit condicional).
 * Utilidade U = Σ wₖ·xₖ; P(escolher i) = softmax(U).
 * A cada escolha do usuário entre alternativas, um passo de gradiente
 * aproxima os pesos do comportamento real, com regularização em direção ao prior.
 */
export type PreferenceWeights = Record<keyof RouteFeatures, number>;

export const PRIOR_WEIGHTS: PreferenceWeights = {
  deltaMin: -0.35,
  deltaKm: -0.04,
  toll: -0.4,
  highwayShare: 0,
  turnsPerKm: -0.15,
  familiarity: 0.4,
  alerts: -0.25,
  uncertaintyMin: -0.12,
};

const FEATURE_KEYS = Object.keys(PRIOR_WEIGHTS) as (keyof RouteFeatures)[];

export interface Candidate {
  route: Route;
  eta: EtaEstimate;
  /** Fração (por tempo) dos trechos que o usuário já percorreu. */
  familiarity: number;
  alerts: number;
}

export function routeFeatures(candidates: Candidate[]): RouteFeatures[] {
  const fastest = Math.min(...candidates.map((c) => c.eta.durationS));
  const shortest = Math.min(...candidates.map((c) => c.route.distanceM));
  return candidates.map((c) => {
    const km = Math.max(0.1, c.route.distanceM / 1000);
    const turns = c.route.maneuvers.filter((m) => ![1, 2, 3, 4, 5, 6, 7, 8, 22].includes(m.type)).length;
    return {
      deltaMin: (c.eta.durationS - fastest) / 60,
      deltaKm: (c.route.distanceM - shortest) / 1000,
      toll: c.route.hasToll ? 1 : 0,
      highwayShare: c.route.highwayShare,
      turnsPerKm: turns / km,
      familiarity: c.familiarity,
      alerts: c.alerts,
      uncertaintyMin: (c.eta.p90S - c.eta.durationS) / 60,
    };
  });
}

export function utility(f: RouteFeatures, w: PreferenceWeights): number {
  return FEATURE_KEYS.reduce((acc, k) => acc + w[k] * f[k], 0);
}

export function choiceProbabilities(features: RouteFeatures[], w: PreferenceWeights): number[] {
  const u = features.map((f) => utility(f, w));
  const max = Math.max(...u);
  const e = u.map((x) => Math.exp(x - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
}

export function updatePreferences(
  w: PreferenceWeights,
  features: RouteFeatures[],
  chosen: number,
  opts: { lr?: number; l2?: number } = {},
): PreferenceWeights {
  if (features.length < 2 || chosen < 0 || chosen >= features.length) return w;
  const lr = opts.lr ?? 0.15;
  const l2 = opts.l2 ?? 0.05;
  const p = choiceProbabilities(features, w);
  const next = { ...w };
  for (const k of FEATURE_KEYS) {
    const expected = features.reduce((acc, f, i) => acc + p[i]! * f[k], 0);
    const grad = features[chosen]![k] - expected;
    next[k] = w[k] + lr * grad - lr * l2 * (w[k] - PRIOR_WEIGHTS[k]);
  }
  // Tempo nunca pode virar algo desejável.
  next.deltaMin = Math.min(-0.05, next.deltaMin);
  return next;
}

export interface Tradeoff {
  feature: keyof RouteFeatures;
  /** Minutos a mais que o usuário aceita (positivo) ou exige de ganho (negativo) por unidade da feature. */
  minutesPerUnit: number;
  label: string;
}

const TRADEOFF_LABEL: Partial<Record<keyof RouteFeatures, (m: number) => string>> = {
  toll: (m) => (m >= 0 ? `Aceita ~${m.toFixed(0)} min a mais para evitar pedágio` : `Paga pedágio se economizar ${(-m).toFixed(0)} min`),
  familiarity: (m) =>
    m <= 0 ? `Aceita ~${(-m).toFixed(0)} min a mais por um caminho conhecido` : 'Gosta de explorar caminhos novos',
  highwayShare: (m) => (m <= 0 ? `Prefere rodovias (aceita ~${(-m).toFixed(0)} min a mais)` : `Evita rodovias (~${m.toFixed(0)} min)`),
  turnsPerKm: (m) => (m >= 0 ? `Evita rotas com muitas conversões (~${m.toFixed(1)} min por conversão/km)` : 'Não se importa com conversões'),
  uncertaintyMin: (m) => (m >= 0 ? `Valoriza previsibilidade (~${m.toFixed(1)} min por min de incerteza)` : 'Aceita rotas imprevisíveis'),
};

/** Converte pesos em trocas legíveis: quantos minutos cada característica "vale". */
export function tradeoffs(w: PreferenceWeights): Tradeoff[] {
  const perMin = -w.deltaMin;
  return (Object.keys(TRADEOFF_LABEL) as (keyof RouteFeatures)[]).map((k) => {
    // U = w_t·Δt + w_k·x ⇒ indiferença quando Δt = −w_k/w_t·x ⇒ minutos aceitos por unidade = w_k/|w_t|
    const minutes = -w[k] / perMin;
    return { feature: k, minutesPerUnit: minutes, label: TRADEOFF_LABEL[k]!(minutes) };
  });
}
