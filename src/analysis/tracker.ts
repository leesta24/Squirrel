// Tracker — probability tracking. The prototype uses the platform-provided 24h change (no need for a custom
// history store) to flag fast-moving markets — such "probability swings" often signal new information arriving
// and are the markets the agent should look at first.

import type { UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";

export interface Mover {
  market: UnifiedMarket;
  yesProb: number;
  /** 24h Yes-probability change (positive = up) */
  change24h: number;
}

export interface TrackOptions {
  limit?: number; // default 10
  minVolume?: number; // filter low-volume noise, default 10000
  minChange?: number; // minimum change magnitude (probability points), default 0.02
}

export function topMovers(markets: UnifiedMarket[], opts: TrackOptions = {}): Mover[] {
  const { limit = 10, minVolume = 10000, minChange = 0.02 } = opts;
  return markets
    .filter((m) => m.priceChange24h !== undefined && (m.volume ?? 0) >= minVolume)
    .map((m) => ({ market: m, yesProb: yesProbability(m) ?? 0, change24h: m.priceChange24h! }))
    .filter((x) => Math.abs(x.change24h) >= minChange)
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, limit);
}
