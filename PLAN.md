# squirror — v2 重构计划

> ARTi 2026 Dev 赛道。预测市场数据源 + 分析框架 + 基于 Pi 的 TradingAgents-lite agent 判断层。
> 状态：**重构计划 / plan of record**。本文档记录架构决策、known gaps、后续实现步骤，也用于提交时解释项目边界。

---

## 1. 题目与目标

ARTi Dev Track 原题要求：

1. 接入 **Polymarket** 和 **Kalshi** 的公开 API，获取实时市场数据（标的、概率、成交量）。
2. 设计一个**分析框架**：筛选有价值标的、追踪概率变化、识别异常信号。
3. 参考 **TradingAgents** 的架构，加入一个简单的 **Agent 判断层**（可以是 prompt + 结构化输出）。
4. 写清 README：数据结构说明、框架设计思路、示例输出。

交付物：GitHub repo，包含数据接入模块 + 分析框架 + README + 示例输出 + **个人简历**。

本项目的定位：

- **主目标**：证明框架能力，而不是声称模型已具备稳定预测 alpha。
- **核心能力**：把多平台预测市场数据标准化为工具层，让 Pi agents 可以通过 tool calls 自主查询、分析、提交结构化判断。
- **提交口径**：当前预测结果受限于公开数据源的覆盖和质量；如果后续接入更完整的历史盘口、成交明细、新闻/宏观数据、结算规则源，框架可以复用，判断质量应随数据源改善而提升。

---

## 2. 当前实现回顾与 Drift

当前 repo 已经完成：

- Polymarket / Kalshi 基础数据 adapter。
- `UnifiedEvent / UnifiedMarket / Outcome` 统一模型。
- `screen / arbitrage / tracker` 三个分析模块。
- 一个 TradingAgents 风格的分析师 -> 辩论 -> 估计 -> 风控顺序 pipeline。
- 示例输出和 README。

但和我们想展示的架构能力相比，存在两个核心 drift：

1. **没有真正基于 Pi agent runtime 做 agent**
   - 当前主要使用 `@earendil-works/pi-ai` 的模型/provider/structured-output 能力。
   - `submit_estimate` / `submit_decision` 更像强制 JSON 输出，不是 agent 在分析过程中主动 tool call、接收 tool result、继续推理。
   - 目标应改为：每个分析节点是一个真实的 `@earendil-works/pi-agent-core` `Agent`，拥有自己的 prompt、toolset、agent loop 和事件流。

2. **TradingAgents 被简化成了写死 workflow**
   - TradingAgents 原项目基于 LangGraph：节点、工具节点、conditional edges、debate state 共同组成图。
   - 当前 `runDebate()` 是手写 round-robin loop，缺少“agent 节点 -> tool calls -> tool node -> 回到 agent 节点”的结构。
   - 目标应改为：实现一个轻量 TradingAgents-lite graph runner；graph 由我们写，agent loop 交给 Pi。

这些 drift 不代表方向错误，但需要在重构中修正，避免提交时说“基于 Pi agent 框架”却只用了 Pi 的模型层。

---

## 3. 架构决策

### ADR-1: 使用 Pi 作为真实 agent runtime

**决策**：使用 `@earendil-works/pi-agent-core` 的 `Agent` 作为每个角色节点的执行运行时。

**理由**：

- Pi 轻量，适合面试题这种原型交付。
- Pi 原生支持 tool calls、tool execution、tool result 后继续下一 turn、事件流、steer/followUp。
- 比直接调用 `llm.text()` 更能体现 agent 能力和可扩展性。

**边界**：

- `@earendil-works/pi-ai` 仍然负责模型/provider/TypeBox schema。
- `@earendil-works/pi-agent-core` 负责单 agent loop。
- 多 agent graph 不由 Pi 原生提供，需要项目自己实现。

### ADR-2: 自研轻量 TradingAgents-lite graph runner

**决策**：不引入 LangGraph；用 TypeScript 实现一个小的 graph runner，编排 Pi Agent 节点。

**理由**：

- Pi agent-core 没有 `StateGraph.add_node/add_edge/add_conditional_edges` 这类 multi-agent graph primitive。
- 题目只要求“参考 TradingAgents”，不需要完整复刻 LangGraph。
- 自研 runner 可以保持 repo 小而清楚，同时解释“Pi provides agent runtime; this repo adds TradingAgents-inspired graph orchestration”。

目标抽象：

```ts
type NodeId =
  | "market_analyst"
  | "microstructure_analyst"
  | "cross_market_analyst"
  | "yes_researcher"
  | "no_researcher"
  | "decision_manager";

interface GraphNode {
  id: NodeId;
  role: RoleConfig;
  tools: AgentTool[];
  next: (state: AnalysisState) => NodeId | "END";
}
```

### ADR-3: API 数据必须通过 tools 暴露给 agent

**决策**：Polymarket / Kalshi 不只是 data adapter，也必须成为 Pi `AgentTool`。

**理由**：

- 面试题明确点名两个 API。
- Agent 判断层应能主动查询市场、盘口、历史概率、结算规则，而不是只吃一段预拼 prompt。
- 工具层是数据源可扩展的关键：未来接更多真实数据源时，不需要重写 agent graph。

### ADR-4: Role-specific toolsets，不做全局工具池

**决策**：每个角色只拿自己需要的工具。

**理由**：

- 减少 tool selection 噪音。
- 更接近 TradingAgents：market/news/fundamentals 等角色各有 tool node。
- 便于解释 prompt/toolset 设计：每个 agent 的信息权限和职责一致。

### ADR-5: 明确把预测准确率和数据源质量解耦

**决策**：README / PLAN / examples 中明确 known gaps：当前 demo 主要展示框架能力，不声称预测结果稳定优于市场。

**理由**：

- 公开 API 的历史深度、盘口快照、新闻、宏观和结算数据不完整。
- LLM 判断没有可靠的未来 ground truth，backtest/OOS 容易受 hindsight、样本选择和数据缺失影响。
- 诚实说明边界，反而能体现工程判断。

---

## 4. 目标架构

```mermaid
flowchart TD
  CLI[CLI: screen / analyze / backtest]

  subgraph D[Data adapters]
    PM[Polymarket REST / CLOB]
    KS[Kalshi Trade API]
    U[Unified Event / Market / Outcome]
    PM --> U
    KS --> U
  end

  subgraph T[Tool layer · Pi AgentTool]
    PT[Polymarket tools]
    KT[Kalshi tools]
    UT[Unified derived tools]
    OT[Output tools: submit_report / submit_verdict]
  end

  subgraph G[TradingAgents-lite graph]
    MA[Market Analyst · Pi Agent]
    MI[Microstructure Analyst · Pi Agent]
    XA[Cross-market / Resolution Analyst · Pi Agent]
    YES[YES Researcher · Pi Agent]
    NO[NO Researcher · Pi Agent]
    DM[Decision Manager · Pi Agent]
  end

  CLI --> D
  U --> T
  CLI --> G
  T --> MA
  T --> MI
  T --> XA
  T --> YES
  T --> NO
  T --> DM
  MA --> MI --> XA --> YES --> NO
  NO -->|round < max| YES
  NO -->|round done| DM
```

三层职责：

- **Data adapters**：只负责真实 API 接入和平台字段归一化。
- **Tool layer**：把原始平台 API 和派生分析能力包装为 Pi `AgentTool`。
- **TradingAgents-lite graph**：负责编排多个 Pi agents、条件流转、共享状态和最终 verdict。

---

## 5. Toolset 设计

### 5.1 必做：题目指定 API tools

Polymarket：

- `polymarket_search_markets`
  - 输入：`query`, `limit`, `active`
  - 输出：候选 market 列表，包含 question、market id、YES probability、volume、liquidity、close time。
- `polymarket_get_market`
  - 输入：`marketId`
  - 输出：市场详情、outcomes、price、volume、liquidity、结算描述。
- `polymarket_get_price_history`
  - 输入：`tokenId`, `interval`, `fidelity`
  - 输出：历史概率序列，用于 drift/momentum/backtest。
- `polymarket_get_orderbook`
  - 输入：`tokenId`
  - 输出：bid/ask/depth，用于微观结构分析。

Kalshi：

- `kalshi_search_markets`
  - 输入：`query`, `limit`, `status`
  - 输出：候选 market/event 列表，包含 ticker、title、YES probability、volume、open interest。
- `kalshi_get_market`
  - 输入：`ticker`
  - 输出：市场详情、yes/no bid/ask、volume、open interest、rules。
- `kalshi_get_orderbook`
  - 输入：`ticker`
  - 输出：orderbook/depth。

### 5.2 必做：统一派生 tools

- `get_verified_market_snapshot`
  - 对某个 `source + marketId` 返回统一可信快照。
  - 作用类似 TradingAgents 的 `get_verified_market_snapshot`：防止 agent 编造价格、成交量、盘口。
- `get_related_markets`
  - 跨 Polymarket / Kalshi 查相似市场，用于同事件候选和异常价差信号。
- `get_probability_history`
  - 返回统一概率历史。Polymarket 可走 CLOB history；Kalshi 若公开历史不足，则返回当前可得快照并标记 gap。
- `get_probability_indicators`
  - 输出 1h/24h/7d 概率变化、概率波动率、bid-ask spread、深度不平衡、volume/liquidity ratio、extreme probability flag。
- `get_cross_platform_anomaly_signals`
  - 输出相似市场间的概率差、相似度、方向一致性风险。命名为 anomaly，不命名为 guaranteed arbitrage。

### 5.3 必做：结构化输出 tools

- `submit_report`
  - Analyst 节点调用。
  - schema: `{ summary, keySignals, risks, confidence, dataGaps }`
  - tool result 可设置 `terminate: true`，表示当前 agent 节点完成。
- `submit_verdict`
  - Decision Manager 调用。
  - schema: `{ side, pHat, marketP, edge, action, size, reasoning, dataGaps }`
  - 最终 verdict 由 tool 参数落入共享 state，而不是从自由文本中解析。

### 5.4 可选：从 TradingAgents 迁移的外部信息 tools

可加，但不作为 MVP 依赖：

- `get_event_news`
  - 类似 TradingAgents 的 `get_news / get_global_news`，用于事件新闻。
  - 风险：需要稳定新闻源；公开搜索结果可能噪声大，且引入 prompt injection 风险。
- `get_macro_indicators`
  - 类似 TradingAgents 的 FRED macro tool，对 Fed、CPI、recession、oil 等市场有帮助。
  - 风险：只覆盖宏观类市场，不适用于体育、娱乐、crypto meme 等大量预测市场。

不建议第一版迁移：

- `get_fundamentals`, `get_balance_sheet`, `get_cashflow`, `get_income_statement`
  - 股票基本面工具，不适合预测市场通用框架。
- `get_insider_transactions`
  - 覆盖面窄，容易偏离题目。
- 股票 TA 指标原样迁移
  - 预测市场份额价格本身就是概率，直接搬 MACD/RSI 叙事容易误导。

### 5.5 Role -> toolset

| Role | Toolset |
|---|---|
| Market Analyst | `polymarket_search_markets`, `kalshi_search_markets`, `get_verified_market_snapshot`, `submit_report` |
| Microstructure Analyst | `polymarket_get_orderbook`, `kalshi_get_orderbook`, `get_probability_history`, `get_probability_indicators`, `submit_report` |
| Cross-market / Resolution Analyst | `get_related_markets`, `polymarket_get_market`, `kalshi_get_market`, `get_cross_platform_anomaly_signals`, `submit_report` |
| YES Researcher | analyst reports + optional `get_verified_market_snapshot`, `submit_report` |
| NO Researcher | analyst reports + optional `get_verified_market_snapshot`, `submit_report` |
| Decision Manager | `submit_verdict` |

---

## 6. Agent 角色

目标版本保持轻量，避免为了“多 agent”堆复杂度。

| TradingAgents 原角色 | 本项目角色 | 目标职责 |
|---|---|---|
| Market Analyst | Market Analyst | 查并核验目标市场基础快照，说明市场价、成交量、流动性、期限 |
| Sentiment / Technical | Microstructure Analyst | 用盘口、价差、概率变化替代股票技术指标 |
| News / Fundamentals | Cross-market / Resolution Analyst | 检查相似市场、结算规则、定义歧义、跨平台异常 |
| Bull Researcher | YES Researcher | 基于报告论证 YES 发生 |
| Bear Researcher | NO Researcher | 基于报告论证 NO 发生 |
| Research Manager / Trader / Risk | Decision Manager | 输出 `pHat`, `edge`, `side`, `action`, `size`, `dataGaps` |

可选扩展：

- `News Analyst`：接入稳定新闻源后启用。
- `Macro Analyst`：接入 FRED/宏观数据后启用。
- `Reflector`：结算后基于 Brier/log-loss 写回经验。

---

## 7. 数据模型

两平台统一为：

```ts
type Source = "polymarket" | "kalshi";

interface UnifiedEvent {
  source: Source;
  id: string;
  title: string;
  slug?: string;
  category?: string;
  closeTime?: string;
  active: boolean;
  mutuallyExclusive: boolean;
  volume?: number;
  liquidity?: number;
  markets: UnifiedMarket[];
}

interface UnifiedMarket {
  source: Source;
  id: string;            // PM: conditionId / Kalshi: ticker
  question: string;
  description?: string;  // settlement rules
  outcomes: Outcome[];
  volume?: number;
  liquidity?: number;
  openInterest?: number;
  priceChange24h?: number;
  closeTime?: string;
  resolution?: {
    resolved: boolean;
    resolvedOutcome?: string;
    status?: string;
  };
  eventId?: string;
}

interface Outcome {
  name: string;
  probability: number;   // normalized to [0,1]
  bid?: number;
  ask?: number;
  tokenId?: string;      // Polymarket CLOB token id
}
```

平台差异：

1. Polymarket Gamma 的 `outcomes` / `outcomePrices` / `clobTokenIds` 是 stringified JSON，需要二次 parse。
2. Kalshi 新版 dollar 字段已是 `[0,1]`，不再除以 100。
3. Kalshi 一条 market 自带 Yes/No；Polymarket 通常通过 outcomes 数组表达。
4. 结算说明、resolution status、盘口深度、历史价格在两个平台覆盖不一致，必须在 tool result 的 `dataGaps` 中显式返回。

---

## 8. Known Gaps

这些 gap 是已知限制，不应在提交中隐瞒。

### 8.1 数据源覆盖 gap

- Polymarket / Kalshi 的公开 API 足够做实时市场快照，但历史盘口、成交明细和统一历史概率覆盖不完整。
- Kalshi 历史概率数据公开能力弱于 Polymarket CLOB history；相关工具需要返回 “unavailable / partial” 而不是伪造。
- 新闻、宏观、社媒、官方事件源尚未作为稳定一等数据源接入。
- 结算规则文本有时不完整或平台间语义不一致；跨平台价差不能直接等同套利。

提交口径：

> This repo targets the framework layer: source adapters, tool-callable market data, multi-agent reasoning, and structured decisions. Predictive quality is data-limited; with richer historical orderbook/trade data, news/macroeconomic feeds, and settlement metadata, the same framework should produce better calibrated estimates.

### 8.2 Agent 能力 gap

- MVP 不保证 agent 预测能稳定 beat market。
- LLM 可能使用训练时记忆，历史 backtest 有 hindsight bias。
- OOS 样本少，结果只能证明验证管线存在，不能证明统计显著 alpha。

### 8.3 工程 gap

- 当前代码尚未完成 Pi `Agent` runtime 重构。
- 当前 agent 编排仍是顺序 workflow，需要改成 graph runner + Pi Agent nodes。
- 简历 PDF 仍需放入 repo 根目录。

---

## 9. 重构计划

| 阶段 | 内容 | 验证标准 |
|---|---|---|
| 1. Tool layer | 新增 `src/agents/tools.ts`，把 Polymarket/Kalshi 和统一派生分析包装成 `AgentTool` | 至少一个 agent 能真实调用 source tool，并收到 tool result |
| 2. Pi Agent node | 新增 `runPiAgentNode(role, tools, state)`，使用 `@earendil-works/pi-agent-core.Agent` | 事件流出现 `tool_execution_start/end`，报告通过 `submit_report` 进入 state |
| 3. Graph runner | 新增轻量 node/edge/conditional runner | analyst -> debate -> decision 路径不靠手写 for-loop 主导 |
| 4. README/PLAN 更新 | 文档改成 TradingAgents-lite on Pi，明确 known gaps | reviewer 能看出选择 Pi 的理由和边界 |
| 5. 示例输出 | 重新捕获 `screen`、`analyze --faux`、真实 `analyze` 输出 | 示例中展示真实 tool calls 和结构化 verdict |

---

## 10. 验证策略

### 数据层

- 拉真实 Polymarket / Kalshi market。
- 断言 `probability` 在 `[0,1]`。
- 对平台字段差异做单元测试或 fixture 测试：PM stringified JSON、Kalshi dollar strings、Yes/No outcome mapping。

### Tool layer

- 每个 source tool 都有最小 smoke test。
- tool result 必须包含 `source`, `timestamp`, `dataGaps`。
- 外部 API 失败时 fail-open：返回结构化错误，不让整个 graph 崩掉。

### Agent layer

- 用 faux/mock 模型验证 graph 不死循环、conditional edge 正确。
- 用真实模型验证至少一次完整 toolcall loop。
- 最终 verdict 必须来自 `submit_verdict` tool 参数，而不是自由文本解析。

### 预测评估

- 保留 Brier score / OOS 作为验证管线。
- 明确统计意义有限，不作为主要交付承诺。

---

## 11. 提交叙事

提交时重点讲：

1. **题目要求的两个 API 已接入**，并统一成框架内部数据模型。
2. **分析框架不是单点脚本**：包含筛选、概率变化、跨平台异常、结算风险。
3. **Pi 的使用是 agent-runtime 层面的**：每个角色是 Pi Agent，有自己的 toolset 和 loop。
4. **TradingAgents 是架构参考**：我们复用其 node/tool/conditional graph 思想，但针对预测市场做轻量化。
5. **预测结果的数据依赖是已知边界**：当前展示框架能力，未来数据源变强后，判断质量才有更大提升空间。

---

## 12. 当前验收契约

目标命令：

```bash
npm run screen
npm run analyze -- --market "<query>" --faux
npm run analyze -- --market "<query>"
npm run backtest --faux
```

通过判据：

- `screen` 输出真实 Polymarket / Kalshi 市场。
- `analyze` 输出 agent 过程、tool calls、最终结构化 verdict。
- README 说明数据结构、框架设计、示例输出、known gaps。
- repo 根目录包含个人简历。
