# State-Driven Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MVP state-driven routing to the v2 Pi Agent graph so debate continuation is decided by structured state, not only a fixed round counter.

**Architecture:** Keep Pi responsible for each single-agent toolcall loop. Add a deterministic Debate Router node to Squirrel's graph runner. The router reads structured report submissions, confidence, data gaps, and debate round bounds, then chooses the next graph node.

**Tech Stack:** TypeScript, `@earendil-works/pi-agent-core`, existing lightweight `GraphNode` / `GraphEdge` runner.

---

### Task 1: Document The Routing Contract

**Files:**
- Modify: `README.md`
- Modify: `PLAN.md`

**Step 1: Add the MVP behavior**

Document that v2 routing is:

```text
YES Researcher -> NO Researcher -> Debate Router
Debate Router:
  if round < min_rounds: continue debate
  else if round >= max_rounds: Debate Judge
  else if latest reports show low confidence or critical data gaps: continue debate
  else: Debate Judge
```

**Step 2: Clarify the boundary**

Document that this is deterministic state-driven routing, not an LLM router. Future work can expand targets to `market_analyst`, `macro_analyst`, `risk_manager`, etc.

**Step 3: Verify docs**

Run:

```bash
git diff --check README.md PLAN.md
```

Expected: no whitespace errors.

---

### Task 2: Extend v2 Structured State

**Files:**
- Modify: `src/agents/orchestrateV2.ts`

**Step 1: Add route state types**

Add:

```ts
type RouteTarget = "yes_researcher" | "debate_judge";

interface RouteDecision {
  round: number;
  next: RouteTarget;
  reason: string;
  signals: string[];
}
```

**Step 2: Store raw reports**

Extend `V2GraphState`:

```ts
reportSubmissions: Record<string, ReportSubmission>;
minDebateRounds: number;
routeDecisions: RouteDecision[];
lastRoute?: RouteDecision;
```

In `makeTools().onReport`, write both formatted text and raw `ReportSubmission`.

**Step 3: Verify type safety**

Run:

```bash
npx tsc --noEmit
```

Expected: pass.

---

### Task 3: Add The Debate Router Node

**Files:**
- Modify: `src/agents/orchestrateV2.ts`
- Modify: `src/agents/rolesV2.ts`

**Step 1: Add config**

Add:

```ts
export const V2_MIN_DEBATE_ROUNDS = 1;
export const V2_MAX_DEBATE_ROUNDS = 2;
```

Keep the current two-round demo behavior when critical gaps remain, but allow early judge after one round when confidence is high and gaps are low.

**Step 2: Add deterministic route function**

Implement:

```ts
function routeAfterDebate(state: V2GraphState): RouteDecision
```

Decision rules:

- continue if `debateRound < minDebateRounds`
- judge if `debateRound >= maxDebateRounds`
- continue if latest YES/NO average confidence `< 0.62`
- continue if latest reports contain critical gaps such as current price, settlement source, volatility, cross-platform validation
- otherwise judge

**Step 3: Add graph node**

Add a `debate_router` node that computes `state.lastRoute`, pushes it into `state.routeDecisions`, and emits progress.

Edges:

```text
NO Researcher -> Debate Router
Debate Router -> state.lastRoute.next
```

**Step 4: Verify demo**

Run:

```bash
npm run analyze -- --v2 --demo-market
```

Expected:

- output includes `[Debate Router]`
- router chooses another debate round for the BTC demo because of critical data gaps
- final verdict still comes from `submit_verdict`

---

### Task 4: Final Verification And Commit

**Files:**
- All modified files

**Step 1: Run checks**

```bash
npx tsc --noEmit
git diff --check
npm run backtest -- --mock
```

**Step 2: Inspect git status**

```bash
git status --short
```

Expected: only intended files changed.

**Step 3: Commit**

```bash
git add README.md PLAN.md src/agents/orchestrateV2.ts src/agents/rolesV2.ts docs/plans/2026-06-27-state-driven-routing.md
git commit -m "Add state-driven v2 debate router"
```
