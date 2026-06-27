// CLI entry point. Three acceptance commands (see PLAN §11):
//   screen                      — data + analysis layer: candidates / cross-platform spreads / probability swings
//   analyze --market <q> [--faux] — agent decision layer, runs the full pipeline on a single market
//   analyze --market <q> --v2     — Pi Agent runtime path with role-specific tool calls
//   backtest [--faux]           — backtest + Brier score
//
// --faux: use a mock LLM (no ANTHROPIC_API_KEY needed) to validate the orchestration logic.

import { fetchAllEvents } from "./data/index.js";
import { screen as runScreen } from "./analysis/screener.js";
import { findArbitrage } from "./analysis/arbitrage.js";
import { topMovers } from "./analysis/tracker.js";
import { createLLM, createFauxLLM, type LLM } from "./agents/llm.js";
import { demoResponder } from "./agents/fauxDemo.js";
import { analyze } from "./agents/orchestrate.js";
import { analyzeV2 } from "./agents/orchestrateV2.js";
import { backtest, FIXTURES } from "./backtest.js";
import { fetchOOSCases, runOOS } from "./oos.js";
import { yesProbability } from "./data/types.js";
import type { Verdict } from "./agents/types.js";
import { existsSync } from "node:fs";

// Load .env.local (AI_GATEWAY_API_KEY, etc.) if present; harmless when absent.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(`--${name}`);
const getOpt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fmtNum(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return n.toFixed(0);
}
const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
const pct = (n: number) => (n * 100).toFixed(1) + "%";
const indent = (s: string) => s.split("\n").map((l) => "    " + l).join("\n");

// ───────────────────────── screen ─────────────────────────

async function screen(): Promise<void> {
  console.log("Fetching markets from both platforms…\n");
  const { data: events, errors } = await fetchAllEvents(100);
  for (const e of errors) console.warn(`⚠️  ${e.source} fetch failed: ${e.error}`);

  const markets = events.flatMap((e) => e.markets);
  const pmN = markets.filter((m) => m.source === "polymarket").length;
  const ksN = markets.filter((m) => m.source === "kalshi").length;
  const bad = markets.filter((m) =>
    m.outcomes.some((o) => o.probability < 0 || o.probability > 1 || !Number.isFinite(o.probability)),
  );
  console.log(
    `Polymarket ${pmN} · Kalshi ${ksN} markets  ` +
      `probability∈[0,1]: ${bad.length === 0 ? "✓" : "✗ " + bad.length + " out of range"}\n`,
  );

  const cands = runScreen(events, { limit: 12 });
  console.log("Top candidates (event-deduped + probability range + uncertainty weighting):");
  console.log("  " + pad("SOURCE", 11) + pad("MARKET", 44) + pad("YES%", 7) + pad("VOL$", 8) + "LIQ$");
  for (const c of cands) {
    console.log(
      "  " +
        pad(c.market.source, 11) +
        pad(c.market.question || c.eventTitle, 44) +
        pad((c.yesProb * 100).toFixed(1) + "%", 7) +
        pad(fmtNum(c.market.volume), 8) +
        fmtNum(c.market.liquidity),
    );
  }

  const arbs = findArbitrage(markets, { limit: 8 });
  console.log("\nCross-platform same-event spread signals (heuristic match, direction needs review):");
  if (arbs.length === 0) {
    console.log("  (no signals above threshold this run)");
  } else {
    console.log("  " + pad("PM MARKET", 42) + pad("PM%", 7) + pad("KALSHI%", 9) + pad("SPREAD", 8) + "SIM");
    for (const a of arbs) {
      console.log(
        "  " +
          pad(a.pm.question, 42) +
          pad((a.pmYes * 100).toFixed(0) + "%", 7) +
          pad((a.kalshiYes * 100).toFixed(0) + "%", 9) +
          pad(a.spreadPp.toFixed(1) + "pp", 8) +
          a.similarity.toFixed(2),
      );
    }
  }

  const movers = topMovers(markets, { limit: 8 });
  console.log("\nProbability swings (last 24h):");
  if (movers.length === 0) {
    console.log("  (no significant swings)");
  } else {
    console.log("  " + pad("SOURCE", 11) + pad("MARKET", 46) + pad("YES%", 7) + "Δ24h");
    for (const mv of movers) {
      const sign = mv.change24h >= 0 ? "+" : "";
      console.log(
        "  " +
          pad(mv.market.source, 11) +
          pad(mv.market.question, 46) +
          pad((mv.yesProb * 100).toFixed(1) + "%", 7) +
          sign + (mv.change24h * 100).toFixed(1) + "pp",
      );
    }
  }
}

// ───────────────────────── analyze ─────────────────────────

function assertRealLLMConfigured(): void {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Set AI_GATEWAY_API_KEY (Vercel AI Gateway) or ANTHROPIC_API_KEY for real runs; " +
        "or pass --faux to validate the pipeline with a mock LLM.",
    );
    process.exit(1);
  }
}

function pickLLM(faux: boolean): LLM {
  if (faux) return createFauxLLM(demoResponder);
  assertRealLLMConfigured();
  return createLLM();
}

function printVerdict(v: Verdict | undefined): void {
  if (!v) return;
  const sign = v.edge >= 0 ? "+" : "";
  console.log("\n════════════════ VERDICT ════════════════");
  console.log(`  side:            ${v.side}`);
  console.log(`  p_hat:           ${pct(v.pHat)}      (our estimated true probability)`);
  console.log(`  market_p:        ${pct(v.marketP)}      (market-implied)`);
  console.log(`  edge:            ${sign}${v.edge.toFixed(3)}`);
  console.log(`  kelly_fraction:  ${pct(v.kellyFraction)}`);
  console.log(`  recommendation:  ${v.recommendation}`);
  console.log(`  reasoning:       ${v.reasoning}`);
  console.log("═════════════════════════════════════════");
}

async function runAnalyze(): Promise<void> {
  const faux = hasFlag("faux");
  const v2 = hasFlag("v2");
  const query = getOpt("market");
  if (v2 && faux) {
    console.error("--v2 uses the real Pi Agent runtime and does not support --faux yet.");
    process.exit(1);
  }
  const llm = v2 ? undefined : pickLLM(faux);
  if (v2) assertRealLLMConfigured();

  console.log("Fetching markets…");
  const { data: events } = await fetchAllEvents(100);
  const markets = events.flatMap((e) => e.markets);
  let market = query
    ? markets.find(
        (m) => m.id === query || m.question.toLowerCase().includes(query.toLowerCase()),
      )
    : runScreen(events, { limit: 1 })[0]?.market;

  if (!market) {
    console.error(query ? `Market not found: ${query}` : "No candidate markets");
    process.exit(1);
  }

  console.log(`\nMarket: "${market.question}"`);
  console.log(`Market-implied YES = ${pct(yesProbability(market) ?? 0.5)}  [${market.source}]`);
  if (faux) console.log("(faux mode: mock LLM, validates orchestration logic only)");
  if (v2) console.log("(v2 mode: Pi Agent runtime, toolcall loops, role-specific toolsets)");
  console.log("");

  const state = v2 ? await analyzeV2(market, {
    allMarkets: markets,
    onProgress: (label, text) => {
      console.log(`[${label}]`);
      console.log(indent(text) + "\n");
    },
  }) : await analyze(llm!, market, {
    onProgress: (label, text) => {
      console.log(`[${label}]`);
      console.log(indent(text) + "\n");
    },
  });
  printVerdict(state.verdict);
}

// ───────────────────────── backtest ─────────────────────────

async function runBacktest(): Promise<void> {
  const faux = hasFlag("faux");
  const llm = pickLLM(faux);
  if (faux) console.log("(faux mode: mock LLM)\n");

  console.log(`Backtesting ${FIXTURES.length} settled events…\n`);
  const sum = await backtest(llm, FIXTURES, (c, pHat) =>
    console.log(`  ✓ ${pad(c.question, 52)} → p_hat ${(pHat * 100).toFixed(0)}%`),
  );

  console.log("\n  " + pad("EVENT", 50) + pad("ACTUAL", 8) + pad("p_hat", 7) + pad("market", 8) + "DIR");
  for (const r of sum.rows) {
    console.log(
      "  " +
        pad(r.question, 50) +
        pad(r.actual === 1 ? "YES" : "NO", 8) +
        pad((r.pHat * 100).toFixed(0) + "%", 7) +
        pad((r.marketP * 100).toFixed(0) + "%", 8) +
        (r.directionCorrect ? "✓" : "✗"),
    );
  }
  const correct = sum.rows.filter((r) => r.directionCorrect).length;
  console.log(`\n  Direction accuracy: ${correct}/${sum.rows.length}`);
  console.log(
    `  Brier (model): ${sum.brierModel.toFixed(3)}   Brier (market baseline): ${sum.brierMarket.toFixed(3)}` +
      `   ${sum.brierModel <= sum.brierMarket ? "✓ no worse than market" : "(above market baseline)"}`,
  );
}

// ───────────────────────── oos (out-of-sample) ─────────────────────────

async function runOos(): Promise<void> {
  console.log("Fetching out-of-sample cases (settled after the 2026-01 model cutoff)…\n");
  const cases = await fetchOOSCases();
  console.log(`\n${cases.length} cases (price taken 14 days before settlement):`);
  console.log("  " + pad("EVENT", 48) + pad("SETTLED", 12) + pad("mkt@-14d", 10) + "ACTUAL");
  for (const c of cases) {
    console.log(
      "  " + pad(c.question, 48) + pad(c.settleDate, 12) +
        pad((c.marketPBefore * 100).toFixed(0) + "%", 10) + (c.actual === 1 ? "YES" : "NO"),
    );
  }
  if (hasFlag("dry")) {
    console.log("\n(--dry: data only, agent skipped)");
    return;
  }

  const llm = pickLLM(hasFlag("faux"));
  console.log("\nRunning the agent on each…\n");
  const sum = await runOOS(llm, cases, (c, pHat) =>
    console.log(`  ✓ ${pad(c.question, 46)} → p_hat ${(pHat * 100).toFixed(0)}%`),
  );

  console.log("\n  " + pad("EVENT", 46) + pad("ACTUAL", 8) + pad("p_hat", 7) + pad("mkt@-14d", 10) + "DIR");
  for (const r of sum.rows) {
    console.log(
      "  " + pad(r.question, 46) + pad(r.actual === 1 ? "YES" : "NO", 8) +
        pad((r.pHat * 100).toFixed(0) + "%", 7) + pad((r.marketPBefore * 100).toFixed(0) + "%", 10) +
        (r.directionCorrect ? "✓" : "✗"),
    );
  }
  const correct = sum.rows.filter((r) => r.directionCorrect).length;
  console.log(`\n  Direction accuracy: ${correct}/${sum.rows.length}`);
  console.log(
    `  Brier — model: ${sum.brierModel.toFixed(3)} | market@-14d: ${sum.brierMarket.toFixed(3)} | naive 50/50: ${sum.brierNaive.toFixed(3)}`,
  );
  console.log(
    `  ${sum.brierModel <= sum.brierMarket ? "✓ model matches/beats the 14-day-out market price" : "✗ model worse than the market price"}`,
  );
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  switch (argv[0]) {
    case "screen":
      await screen();
      break;
    case "analyze":
      await runAnalyze();
      break;
    case "backtest":
      await runBacktest();
      break;
    case "oos":
      await runOos();
      break;
    default:
      console.log("Usage: npm run <screen | analyze -- --market <q> [--faux|--v2] | backtest [--faux] | oos [--dry|--faux]>");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("Runtime error:", e);
  process.exit(1);
});
