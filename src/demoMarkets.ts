import type { UnifiedMarket } from "./data/types.js";

export const DEMO_MARKETS: UnifiedMarket[] = [
  {
    source: "polymarket",
    id: "demo-polymarket-btc-150k-2026",
    eventId: "demo-btc-150k-2026",
    question: "Will Bitcoin close at or above $150,000 on December 31, 2026?",
    description:
      "Demo market for exercising the Pi Agent graph when live exchange APIs are unavailable. Resolves YES if a widely used BTC/USD reference price closes at or above $150,000 on December 31, 2026; otherwise NO.",
    outcomes: [
      { name: "Yes", probability: 0.34, bid: 0.33, ask: 0.35 },
      { name: "No", probability: 0.66, bid: 0.65, ask: 0.67 },
    ],
    volume: 820000,
    liquidity: 145000,
    priceChange24h: 0.015,
    closeTime: "2026-12-31T23:59:59Z",
  },
  {
    source: "kalshi",
    id: "DEMO-BTC-150K-26",
    eventId: "DEMO-BTC-150K-26",
    question: "Will Bitcoin be $150,000 or higher on Dec 31, 2026?",
    description:
      "Demo related market used for local cross-platform anomaly checks. Resolves YES if BTC/USD is at or above $150,000 at the specified end-of-year reference time.",
    outcomes: [
      { name: "Yes", probability: 0.29, bid: 0.28, ask: 0.3 },
      { name: "No", probability: 0.71, bid: 0.7, ask: 0.72 },
    ],
    volume: 360000,
    liquidity: 91000,
    openInterest: 42000,
    priceChange24h: -0.005,
    closeTime: "2026-12-31T23:59:59Z",
  },
  {
    source: "kalshi",
    id: "DEMO-FED-CUT-SEP26",
    eventId: "DEMO-FED-CUT-SEP26",
    question: "Will the Federal Reserve cut interest rates at the September 2026 meeting?",
    description:
      "Demo macro market. Resolves YES if the FOMC lowers the target range for the federal funds rate at its September 2026 meeting.",
    outcomes: [
      { name: "Yes", probability: 0.47, bid: 0.46, ask: 0.48 },
      { name: "No", probability: 0.53, bid: 0.52, ask: 0.54 },
    ],
    volume: 510000,
    liquidity: 112000,
    openInterest: 78000,
    priceChange24h: 0.02,
    closeTime: "2026-09-16T23:59:59Z",
  },
];

export function pickDemoMarket(query?: string): UnifiedMarket {
  if (!query) return DEMO_MARKETS[0]!;
  const q = query.toLowerCase();
  return DEMO_MARKETS.find((market) =>
    market.id.toLowerCase() === q || market.question.toLowerCase().includes(q),
  ) ?? DEMO_MARKETS[0]!;
}
