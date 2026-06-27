// Type contracts for the agent decision layer.
// Design principles (see PLAN §5): roles are "declarative config", debate teams are "first-class config",
// and state is a "generic container" — adding roles / changing topology only touches config, not the orchestration core.

import type { TSchema } from "typebox";
import type { UnifiedMarket } from "../data/types.js";

/** Two-tier model: deep=heavy reasoning (debate/estimation), quick=light tasks */
export type Tier = "deep" | "quick";

/** Declarative role config — one role = one config, run by a generic executor */
export interface RoleConfig {
  id: string;
  label: string;
  tier: Tier;
  systemPrompt: string;
}

/** Debate team config — adding a debate team = adding one config */
export interface DebateTeam {
  id: string;
  /** The opposing sides (e.g. YES vs NO) */
  participants: [RoleConfig, RoleConfig];
  rounds: number;
  judge: RoleConfig;
}

/** Structured-output tool (typebox schema), used with toolChoice to force the model's output */
export interface StructuredTool {
  name: string;
  description: string;
  parameters: TSchema;
}

export interface Verdict {
  side: "YES" | "NO" | "PASS";
  /** Our estimated true probability */
  pHat: number;
  /** Market-implied probability */
  marketP: number;
  /** edge = pHat - marketP (YES perspective) */
  edge: number;
  /** Suggested fractional-Kelly position (fraction of bankroll) */
  kellyFraction: number;
  recommendation: string;
  reasoning: string;
}

/** Generic state container — adding roles doesn't change the schema; reports go into reports[roleId] */
export interface AnalysisState {
  market: UnifiedMarket;
  /** Market-implied Yes probability */
  marketP: number;
  /** Market + analysis-signal context injected into each agent */
  context: string;
  /** roleId -> the report produced by that role */
  reports: Record<string, string>;
  debate?: { transcript: string; winner: string; judgement: string };
  estimate?: { pHat: number; reasoning: string };
  verdict?: Verdict;
}
