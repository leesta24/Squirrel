// Screener — pick the "markets worth analyzing" out of raw events.
// Solves two problems with sorting purely by volume:
//  1. Multi-choice events (e.g. a 48-leg World Cup) dominate → cap per event with maxPerEvent.
//  2. Extreme probabilities (near 0/1) have no betting value → probability-range filter + uncertainty weighting.

import type { UnifiedEvent, UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";

export interface Candidate {
  market: UnifiedMarket;
  eventTitle: string;
  yesProb: number;
  score: number;
}

export interface ScreenOptions {
  minProb?: number; // default 0.05
  maxProb?: number; // default 0.95
  maxPerEvent?: number; // max legs per event, default 2
  limit?: number; // number of outputs, default 20
}

// Score: volume primary, liquidity secondary, weighted more as probability nears 0.5 (higher uncertainty).
function score(m: UnifiedMarket, p: number): number {
  const vol = m.volume ?? 0;
  const liq = m.liquidity ?? 0;
  const uncertainty = 1 - Math.abs(p - 0.5) * 2; // 0..1, equals 1 when p=0.5
  return (vol + liq * 0.5) * (0.5 + 0.5 * uncertainty);
}

export function screen(events: UnifiedEvent[], opts: ScreenOptions = {}): Candidate[] {
  const { minProb = 0.05, maxProb = 0.95, maxPerEvent = 2, limit = 20 } = opts;
  const candidates: Candidate[] = [];

  for (const ev of events) {
    const eligible = ev.markets
      .map((m) => ({ m, p: yesProbability(m) }))
      .filter(
        (x): x is { m: UnifiedMarket; p: number } =>
          x.p !== undefined && x.p >= minProb && x.p <= maxProb,
      )
      .sort((a, b) => (b.m.volume ?? 0) - (a.m.volume ?? 0))
      .slice(0, maxPerEvent);

    for (const { m, p } of eligible) {
      candidates.push({
        market: m,
        eventTitle: ev.title || m.question,
        yesProb: p,
        score: score(m, p),
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
