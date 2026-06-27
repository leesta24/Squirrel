// Arbitrage — detect probability spreads across the two platforms for "likely the same event".
//
// Matching is heuristic: normalize titles into token sets, find candidate pairs via an inverted index,
// and compute Jaccard similarity.
// ⚠️ Limitation (known for the prototype): high similarity doesn't imply the outcomes point the same way
//    (one may ask "X happens" while the other asks the opposite), so the output is a "signal to be checked
//    by a human/agent", not a guaranteed, directly-arbitrable opportunity.
//    The stage-3 agent decision layer re-checks direction and comparability.

import type { UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";

const STOPWORDS = new Set([
  "will", "the", "a", "an", "in", "on", "by", "to", "of", "for", "is", "at", "be",
  "before", "after", "and", "or", "win", "wins", "next", "this", "that", "what",
  "who", "when", "which", "than", "more", "less", "first", "any", "his", "her",
  "2024", "2025", "2026", "2027", "2028", "2029", "2030",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ArbSignal {
  pm: UnifiedMarket;
  kalshi: UnifiedMarket;
  similarity: number;
  pmYes: number;
  kalshiYes: number;
  /** Probability spread (percentage points) */
  spreadPp: number;
}

export interface ArbOptions {
  minSimilarity?: number; // default 0.5
  minSpreadPp?: number; // default 2
  limit?: number; // default 20
}

export function findArbitrage(markets: UnifiedMarket[], opts: ArbOptions = {}): ArbSignal[] {
  const { minSimilarity = 0.5, minSpreadPp = 2, limit = 20 } = opts;
  const pm = markets.filter((m) => m.source === "polymarket");
  const ks = markets.filter((m) => m.source === "kalshi");

  // Inverted index token -> kalshi market index, avoiding an O(n*m) full comparison
  const tokById = new Map<string, Set<string>>();
  const index = new Map<string, number[]>();
  ks.forEach((m, i) => {
    const t = tokenize(`${m.question} ${m.outcomes[0]?.name ?? ""}`);
    tokById.set(m.id, t);
    for (const tok of t) {
      const arr = index.get(tok);
      if (arr) arr.push(i);
      else index.set(tok, [i]);
    }
  });

  const signals: ArbSignal[] = [];
  for (const p of pm) {
    const pt = tokenize(`${p.question} ${p.outcomes[0]?.name ?? ""}`);
    const candIdx = new Set<number>();
    for (const tok of pt) for (const i of index.get(tok) ?? []) candIdx.add(i);

    let best: { k: UnifiedMarket; sim: number } | null = null;
    for (const i of candIdx) {
      const k = ks[i]!;
      const sim = jaccard(pt, tokById.get(k.id)!);
      if (sim >= minSimilarity && (!best || sim > best.sim)) best = { k, sim };
    }
    if (!best) continue;

    const pmYes = yesProbability(p);
    const kYes = yesProbability(best.k);
    if (pmYes === undefined || kYes === undefined) continue;
    const spreadPp = Math.abs(pmYes - kYes) * 100;
    if (spreadPp < minSpreadPp) continue;

    signals.push({ pm: p, kalshi: best.k, similarity: best.sim, pmYes, kalshiYes: kYes, spreadPp });
  }

  return signals.sort((a, b) => b.spreadPp - a.spreadPp).slice(0, limit);
}
