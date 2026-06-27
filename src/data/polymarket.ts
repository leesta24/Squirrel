// Polymarket adapter — Gamma API (gamma-api.polymarket.com).
// Reading public market data needs no key/auth (verified against the live API).
//
// Platform quirks (verified):
//  - market.outcomes / outcomePrices / clobTokenIds are "stringified JSON" and need a second parse;
//    the three arrays align by index (0=Yes, 1=No).
//  - Prices are already [0,1] strings.
//  - Multi-choice events are flagged via negRisk (multiple binary markets under one event).

import { fetchJson } from "./http.js";
import type { UnifiedEvent, UnifiedMarket, Outcome } from "./types.js";
import { toProbability } from "./types.js";

const GAMMA = "https://gamma-api.polymarket.com";

interface RawMarket {
  conditionId?: string;
  question?: string;
  description?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  volumeNum?: number;
  liquidityNum?: number;
  bestBid?: number;
  bestAsk?: number;
  oneDayPriceChange?: number;
  endDate?: string;
  closed?: boolean;
  umaResolutionStatuses?: string;
}

interface RawEvent {
  id?: string;
  title?: string;
  slug?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  negRisk?: boolean;
  volume?: number;
  liquidity?: number;
  markets?: RawMarket[];
  tags?: { label?: string }[];
}

/** Safely parse a stringified JSON array; returns an empty array on failure. */
function parseArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function mapMarket(m: RawMarket, eventId: string | undefined): UnifiedMarket | null {
  if (!m.conditionId) return null;
  const names = parseArray(m.outcomes);
  const prices = parseArray(m.outcomePrices);
  const tokens = parseArray(m.clobTokenIds);
  if (names.length === 0) return null;

  const outcomes: Outcome[] = names.map((name, i) => {
    const out: Outcome = {
      name,
      probability: toProbability(prices[i]) ?? 0,
    };
    const tok = tokens[i];
    if (tok !== undefined) out.tokenId = tok;
    // bestBid/bestAsk are this market's Yes-side quotes; attach to the 0th outcome
    if (i === 0) {
      if (m.bestBid !== undefined) out.bid = m.bestBid;
      if (m.bestAsk !== undefined) out.ask = m.bestAsk;
    }
    return out;
  });

  const market: UnifiedMarket = {
    source: "polymarket",
    id: m.conditionId,
    question: m.question ?? "",
    outcomes,
  };
  if (m.description) market.description = m.description;
  if (m.volumeNum !== undefined) market.volume = m.volumeNum;
  if (m.liquidityNum !== undefined) market.liquidity = m.liquidityNum;
  if (m.oneDayPriceChange !== undefined) market.priceChange24h = m.oneDayPriceChange;
  if (m.endDate) market.closeTime = m.endDate;
  if (eventId) market.eventId = eventId;
  if (m.closed) {
    market.resolution = { resolved: true, status: m.umaResolutionStatuses };
  }
  return market;
}

function mapEvent(e: RawEvent): UnifiedEvent {
  const event: UnifiedEvent = {
    source: "polymarket",
    id: e.id ?? "",
    title: (e.title ?? "").trim(),
    active: e.active ?? false,
    mutuallyExclusive: e.negRisk ?? false,
    markets: (e.markets ?? [])
      .map((m) => mapMarket(m, e.id))
      .filter((m): m is UnifiedMarket => m !== null),
  };
  if (e.slug) event.slug = e.slug;
  if (e.endDate) event.closeTime = e.endDate;
  if (e.volume !== undefined) event.volume = e.volume;
  if (e.liquidity !== undefined) event.liquidity = e.liquidity;
  const tag = e.tags?.[0]?.label;
  if (tag) event.category = tag;
  return event;
}

/** Fetch active events (descending by volume), returned as the unified model. */
export async function fetchEvents(limit = 50): Promise<UnifiedEvent[]> {
  const url = `${GAMMA}/events?limit=${limit}&active=true&closed=false&order=volume&ascending=false`;
  const raw = await fetchJson<RawEvent[]>(url);
  return raw.map(mapEvent);
}

/** Fetch active markets (flat, descending by volume). */
export async function fetchMarkets(limit = 100): Promise<UnifiedMarket[]> {
  const url = `${GAMMA}/markets?limit=${limit}&active=true&closed=false&order=volumeNum&ascending=false`;
  const raw = await fetchJson<RawMarket[]>(url);
  return raw.map((m) => mapMarket(m, undefined)).filter((m): m is UnifiedMarket => m !== null);
}
