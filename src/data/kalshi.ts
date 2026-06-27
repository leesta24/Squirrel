// Kalshi adapter — Trade API v2 (external-api.kalshi.com).
// Reading public data needs no key/login/signing (verified against the live API);
// signing + the geo wall only kick in when trading/generating keys, irrelevant to read-only analysis.
//
// Platform quirks (verified):
//  - The right path is /events?with_nested_markets=true — the /markets endpoint is drowned in sports combos.
//  - Prices are dollars strings (yes_bid_dollars etc.), already [0,1]; parseFloat is enough, no /100.
//    (The old docs' "1-99 cent integers" were replaced by the new dollars fields.)
//  - Volume is volume_fp, OI is open_interest_fp (note the _fp suffix).
//  - Each market carries one Yes/No; multiple markets under a mutually_exclusive event = multi-choice.
//  - Combo markets carry mve_selected_legs; skipped here (not typical binary markets).

import { fetchJson } from "./http.js";
import type { UnifiedEvent, UnifiedMarket, Outcome } from "./types.js";
import { toProbability } from "./types.js";

const BASE = "https://external-api.kalshi.com/trade-api/v2";

interface RawMarket {
  ticker?: string;
  title?: string;
  yes_sub_title?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  previous_price_dollars?: string;
  volume_fp?: string | number;
  liquidity_dollars?: string;
  open_interest_fp?: string | number;
  close_time?: string;
  status?: string;
  result?: string;
  rules_primary?: string;
  event_ticker?: string;
  mve_selected_legs?: unknown[];
}

interface RawEvent {
  event_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  markets?: RawMarket[];
}

interface EventsResponse {
  events?: RawEvent[];
  cursor?: string;
}

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
};

/** Yes-side probability: prefer the bid/ask midpoint, fall back to last trade price when the orderbook is missing. */
function yesProb(m: RawMarket): number {
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  if (bid !== undefined && ask !== undefined && (bid > 0 || ask > 0)) {
    return toProbability((bid + ask) / 2) ?? 0;
  }
  return toProbability(m.last_price_dollars) ?? 0;
}

function mapMarket(m: RawMarket): UnifiedMarket | null {
  if (!m.ticker || m.mve_selected_legs?.length) return null; // skip combos
  const p = yesProb(m);
  const yes: Outcome = {
    name: m.yes_sub_title?.trim() || "Yes",
    probability: p,
  };
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  if (bid !== undefined) yes.bid = bid;
  if (ask !== undefined) yes.ask = ask;
  const no: Outcome = { name: "No", probability: toProbability(1 - p) ?? 0 };

  const market: UnifiedMarket = {
    source: "kalshi",
    id: m.ticker,
    question: m.title ?? "",
    outcomes: [yes, no],
  };
  if (m.rules_primary) market.description = m.rules_primary;
  const v = num(m.volume_fp);
  const liq = num(m.liquidity_dollars);
  const oi = num(m.open_interest_fp);
  if (v !== undefined) market.volume = v;
  if (liq !== undefined) market.liquidity = liq;
  if (oi !== undefined) market.openInterest = oi;
  const prev = num(m.previous_price_dollars);
  const last = num(m.last_price_dollars);
  if (prev !== undefined && last !== undefined) market.priceChange24h = last - prev;
  if (m.close_time) market.closeTime = m.close_time;
  if (m.event_ticker) market.eventId = m.event_ticker;
  if (m.status === "settled" || m.status === "finalized" || m.result) {
    const res: UnifiedMarket["resolution"] = { resolved: true };
    if (m.status) res.status = m.status;
    if (m.result) res.resolvedOutcome = m.result;
    market.resolution = res;
  }
  return market;
}

function mapEvent(e: RawEvent): UnifiedEvent {
  const markets = (e.markets ?? [])
    .map(mapMarket)
    .filter((m): m is UnifiedMarket => m !== null);
  const event: UnifiedEvent = {
    source: "kalshi",
    id: e.event_ticker ?? "",
    title: (e.title ?? "").trim(),
    active: true,
    mutuallyExclusive: e.mutually_exclusive ?? false,
    markets,
    // Kalshi doesn't give event-level volume/liquidity directly; aggregate from child markets
    volume: markets.reduce((s, m) => s + (m.volume ?? 0), 0),
    liquidity: markets.reduce((s, m) => s + (m.liquidity ?? 0), 0),
  };
  if (e.sub_title) event.slug = e.sub_title;
  if (e.category) event.category = e.category;
  return event;
}

/** Fetch open events (with nested markets), returned as the unified model. */
export async function fetchEvents(limit = 200): Promise<UnifiedEvent[]> {
  const url = `${BASE}/events?limit=${limit}&status=open&with_nested_markets=true`;
  const data = await fetchJson<EventsResponse>(url);
  return (data.events ?? []).map(mapEvent).filter((e) => e.markets.length > 0);
}

/** Fetch open markets (flat). Internally goes through the events endpoint and flattens, avoiding combo noise. */
export async function fetchMarkets(limit = 200): Promise<UnifiedMarket[]> {
  const events = await fetchEvents(limit);
  return events.flatMap((e) => e.markets);
}
