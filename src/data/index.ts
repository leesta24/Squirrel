// Data-layer aggregation: fetch both platforms in parallel; one source failing doesn't affect the other (graceful degradation).

import * as polymarket from "./polymarket.js";
import * as kalshi from "./kalshi.js";
import type { UnifiedEvent, UnifiedMarket } from "./types.js";

export * from "./types.js";

export interface FetchResult<T> {
  data: T;
  /** Failed data sources and their reasons (for CLI hints, non-blocking) */
  errors: { source: string; error: string }[];
}

export async function fetchAllEvents(
  limitPerSource = 100,
): Promise<FetchResult<UnifiedEvent[]>> {
  const sources: [string, Promise<UnifiedEvent[]>][] = [
    ["polymarket", polymarket.fetchEvents(limitPerSource)],
    ["kalshi", kalshi.fetchEvents(limitPerSource * 2)], // Kalshi markets are finer-grained, fetch more
  ];
  const settled = await Promise.allSettled(sources.map(([, p]) => p));
  const data: UnifiedEvent[] = [];
  const errors: FetchResult<unknown>["errors"] = [];
  settled.forEach((r, i) => {
    const name = sources[i]![0];
    if (r.status === "fulfilled") data.push(...r.value);
    else errors.push({ source: name, error: String(r.reason) });
  });
  return { data, errors };
}

export async function fetchAllMarkets(
  limitPerSource = 100,
): Promise<FetchResult<UnifiedMarket[]>> {
  const { data: events, errors } = await fetchAllEvents(limitPerSource);
  return { data: events.flatMap((e) => e.markets), errors };
}
