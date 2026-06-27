# prediction-market-agents

A **prediction-market data source + a TradingAgents-style multi-agent analysis framework**, built for
the ARTi 2026 Dev track. It ingests live markets from **Polymarket** and **Kalshi**, normalizes them
into one model, screens for tradeable targets, detects cross-platform price gaps, and runs a
multi-agent debate pipeline that outputs a calibrated probability estimate and a Kelly-sized position.

The core idea: stock trading bets on **price direction**; prediction markets bet on the gap between the
**market-implied probability and the true probability** (mispricing). Binary 0/1 settlement also gives
an unusually clean ground truth for evaluation.

---

## Architecture

```mermaid
flowchart TD
  subgraph D[Data layer]
    PM[polymarket.ts] --> U[Unified Event/Market model<br/>probability normalized to 0..1]
    KS[kalshi.ts] --> U
  end
  subgraph A[Analysis layer]
    SC[screener · dedup + probability band]
    AR[arbitrage · cross-platform spread]
    TR[tracker · 24h probability moves]
  end
  subgraph G[Agent layer · Pi orchestration]
    AN[Analysts ×4] --> DB[YES/NO debate] --> ES[Estimator · p_hat] --> RK[Risk · Kelly] --> V[Structured verdict]
  end
  D --> A --> G
```

Three layers, decoupled:

- **Data layer** (`src/data/`) — per-platform adapters map raw API payloads into a unified
  `Event / Market / Outcome` model with probabilities normalized to `[0, 1]`. Reading public data needs
  **no API key** on either platform.
- **Analysis layer** (`src/analysis/`) — `screener` (find tradeable targets), `arbitrage` (cross-platform
  spread signals), `tracker` (probability momentum).
- **Agent layer** (`src/agents/`) — a TradingAgents pipeline re-implemented on the [Pi](https://github.com/earendil-works/pi)
  SDK: analysts → adversarial YES/NO debate → estimator → risk/Kelly → structured verdict.

### Agent roles: TradingAgents → prediction markets

The skeleton (analysts → adversarial debate → decision → risk → verdict) is kept intact; only the
**data sources and output semantics** of each role change.

| TradingAgents (original) | This project | Model | What changed |
|---|---|---|---|
| Fundamentals Analyst | **Base-Rate Analyst** | haiku | Historical base rates / polls / official stats, not earnings |
| News Analyst | **News Analyst** (promoted to core) | opus | Event-time sensitivity: how much does news move the true probability |
| Sentiment Analyst | **Microstructure & Sentiment** | haiku | Orderbook liquidity + herding + cross-platform gap |
| Technical Analyst | *removed* | — | Share price *is* the probability; TA is meaningless |
| Bull vs Bear debate | **YES vs NO debate** | opus | The most valuable transferable part — kept as-is |
| Research Manager | **Research Manager** | opus | Judges the stronger side |
| Trader (BUY/SELL/HOLD) | **Estimator** | opus | Outputs `p_hat` and `edge = p_hat − market_p` |
| Risk team + Fund Manager | **Risk / Kelly** | opus | Fractional-Kelly position sizing |
| — (new) | **Resolution-Risk Analyst** | haiku | Settlement risk: ambiguous definitions, unreliable source, voiding |
| Reflector (memory) | *architecture only* | — | Brier-score reflection — see [Extension points](#extension-points) |

---

## Design: where this improves on the original

Reading the TradingAgents source, the data/LLM layers are clean but the **agent definitions and debate
topology are hardcoded** — adding a role means editing 4–5 files plus a reflection-based `should_continue_<key>`
convention. This project keeps what is good and fixes the pain points:

| Original pain point | Here |
|---|---|
| Prompts hardcoded in factory functions | Roles are **declarative config** (`agents/roles.ts`); one generic executor runs them |
| `should_continue_<key>` reflection convention | One generic loop drives every role |
| Debate topology hand-wired | A debate team is **config** (`{ participants, rounds, judge }`) |
| Flat, hardcoded state keys | Generic container `reports: Record<roleId, string>` — adding a role doesn't touch the schema |

Net effect: adding the Resolution-Risk analyst, or reusing the bull/bear team as YES/NO, is **just config** —
the orchestration internals don't change.

---

## Setup

```bash
npm install
```

Requires Node 20+. The agent layer needs a model key for real runs — put one in `.env.local`
(auto-loaded by the CLI, gitignored):

```bash
cp .env.example .env.local
# then set ONE of:
#   AI_GATEWAY_API_KEY=vck_...   (preferred — Vercel AI Gateway, one key for many providers)
#   ANTHROPIC_API_KEY=sk-ant-... (direct Anthropic)
```

The gateway is the default backend (verified end-to-end with `anthropic/claude-opus-4.8` +
`anthropic/claude-haiku-4.5`). Without any key you can still run the data/analysis layer (`screen`)
and validate the agent pipeline with `--faux` (a mock LLM that exercises the full orchestration
without API calls).

> **Local dev note:** if you sit behind an HTTP proxy, Node's native `fetch` ignores proxy env vars by
> default. Prefix commands with `NODE_USE_ENV_PROXY=1`.

---

## Usage

### `screen` — data + analysis layer

```bash
npm run screen
```

Pulls both platforms, prints top candidates (event-deduped, probability-banded, uncertainty-weighted),
cross-platform spread signals, and 24h probability movers. No API key needed.

### `analyze` — agent decision layer

```bash
npm run analyze -- --market "fed"          # real run (needs a key in .env.local)
npm run analyze -- --market "fed" --faux   # mock LLM, validates the pipeline
```

`--market` matches a market id or a substring of the question; omit it to pick the top screened
candidate. Streams each role's output, then prints a structured verdict:
`side · p_hat · market_p · edge · kelly_fraction · recommendation · reasoning`.

### `backtest` — agent validation

```bash
npm run backtest           # real Claude run
npm run backtest --faux    # mock LLM
```

Runs the pipeline over already-settled events (feeding only pre-settlement prices), then reports
direction accuracy and **Brier score** vs the market-price baseline.

See [`examples/`](examples/) for captured outputs.

---

## How to verify it works

| Command | Pass criteria |
|---|---|
| `npm run screen` | Real market names (not mock), all `probability∈[0,1]`, spread signals appear |
| `npm run analyze -- --market <q>` | Full pipeline runs, every role speaks, debate ends on configured rounds, verdict passes schema |
| `npm run backtest` | Brier score computes, direction is non-random (not required to beat the market) |

`tsc --noEmit` typechecks the whole project (`strict` + `noUncheckedIndexedAccess`).

---

## Data model

Both platforms are an `Event → Markets` hierarchy, unified in `src/data/types.ts`:

```ts
interface UnifiedMarket {
  source: "polymarket" | "kalshi";
  id: string;            // PM: conditionId / Kalshi: ticker
  question: string;
  description?: string;  // settlement rules (PM description / Kalshi rules_primary)
  outcomes: Outcome[];   // { name, probability∈[0,1], bid?, ask?, tokenId? }
  volume?: number; liquidity?: number; openInterest?: number;
  priceChange24h?: number;
  resolution?: { resolved: boolean; resolvedOutcome?: string; status?: string };
}
```

Platform quirks the adapters smooth over (all verified against the live APIs):

- **Polymarket** returns `outcomes` / `outcomePrices` / `clobTokenIds` as *stringified JSON* — parsed again;
  same index ⇒ same outcome (0=Yes, 1=No). Prices are already `[0,1]`.
- **Kalshi** prices are *dollar strings* (`yes_bid_dollars`, ...), already `[0,1]` — **no /100** (older docs'
  "1–99 cents" is outdated). Volume is `volume_fp`, OI is `open_interest_fp`. The right entry point is
  `/events?with_nested_markets=true` — the flat `/markets` endpoint is flooded with combo markets.

---

## Known limitations

- **Cross-platform matching is heuristic.** Title-token Jaccard finds *candidate* same-event pairs, but a
  high similarity does not guarantee the two outcomes are defined the same way (one may ask "X happens",
  the other "X first"). Large spreads are often apples-to-oranges, not arbitrage — they are signals to be
  checked, which is exactly what the agent layer's resolution-risk / comparability review is for.
- **`--faux` is a mock.** It validates orchestration logic only; real probability estimates require a Claude
  key. Pi-SDK integration is exercised by the real path.
- **Backtest has hindsight bias.** Fixtures are *already-settled* events (e.g. GTA VI slipped, BTC hit
  $100k), so the model likely "remembers" the outcomes from training data — the 5/5 direction and
  Brier 0.072 (vs 0.162 market) demonstrate the *metric pipeline works and direction is sane*, not
  genuine forward-looking skill. Unbiased validation needs pre-settlement snapshots via the
  prices-history API (see extension points).

## Extension points

- **Reflection/memory layer** — after settlement, score each estimate with Brier/log-loss and write it back
  into per-role memory for injection on the next run (the backtest already implements the offline metric).
- **Fully automated backtest** — pull settled markets and fetch pre-settlement prices via Polymarket's
  `prices-history` API instead of fixtures.
- **More roles** — add a config object to `agents/roles.ts`; the executor and orchestrator don't change.
- **ARTi integration** — the agent layer is a plain function `analyze(llm, market)`; wrap it as an ARTi
  tool/skill, or swap `llm.ts` to route through ARTi's model layer.

## Project layout

```
src/
  data/      types · polymarket · kalshi · http · index   (unified data layer)
  analysis/  screener · arbitrage · tracker               (analysis layer)
  agents/    types · llm · roles · verdict · orchestrate · fauxDemo
  backtest.ts                                              (Brier-score validation)
  cli.ts                                                   (screen / analyze / backtest)
examples/                                                  (captured outputs)
PLAN.md                                                    (design doc)
```
