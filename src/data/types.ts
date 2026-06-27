// Unified cross-platform data model.
// Both platforms (Polymarket / Kalshi) share a "markets aggregated under an event" hierarchy.
// This layer normalizes the differences in price units, outcome modeling, and field naming,
// exposing a single contract to the layers above.

export type Source = "polymarket" | "kalshi";

export interface Outcome {
  /** Outcome name: "Yes" / "No" / candidate name (e.g. "Anthropic") */
  name: string;
  /** Market-implied probability, normalized to [0,1] */
  probability: number;
  /** Best bid/ask (share price, [0,1]), may be missing */
  bid?: number;
  ask?: number;
  /** Polymarket only: CLOB token id for orderbook/history lookups */
  tokenId?: string;
}

export interface ResolutionInfo {
  /** Whether the market has settled */
  resolved: boolean;
  /** Settlement result (when resolved): the winning outcome name */
  resolvedOutcome?: string;
  /** Raw settlement status (PM: UMA status / Kalshi: result field) */
  status?: string;
}

export interface UnifiedMarket {
  source: Source;
  /** Unique market id — PM: conditionId / Kalshi: ticker */
  id: string;
  question: string;
  /** Settlement rules/description (PM: description / Kalshi: rules_primary), for the Resolution-Risk agent */
  description?: string;
  outcomes: Outcome[];
  volume?: number;
  liquidity?: number;
  /** Kalshi only */
  openInterest?: number;
  /** Yes-side 24h probability change (probability points, platform-provided; positive = up) */
  priceChange24h?: number;
  closeTime?: string;
  resolution?: ResolutionInfo;
  /** Platform event id (to trace back to the owning event) */
  eventId?: string;
}

export interface UnifiedEvent {
  source: Source;
  /** Unique event id — PM: event id / Kalshi: event_ticker */
  id: string;
  title: string;
  slug?: string;
  category?: string;
  closeTime?: string;
  active: boolean;
  /** Mutually exclusive multi-choice (PM: negRisk / Kalshi: mutually_exclusive) */
  mutuallyExclusive: boolean;
  volume?: number;
  liquidity?: number;
  markets: UnifiedMarket[];
}

/** Get a market's "Yes"-side probability (common for binary markets). By convention outcomes[0] is the Yes side. */
export function yesProbability(m: UnifiedMarket): number | undefined {
  return m.outcomes[0]?.probability;
}

/** Safely parse any number/string into a [0,1] probability; returns undefined for invalid values. */
export function toProbability(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
