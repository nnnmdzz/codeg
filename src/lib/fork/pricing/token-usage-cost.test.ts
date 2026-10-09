import { describe, expect, it } from "vitest"
import type {
  TokenUsageBreakdownItem,
  TokenUsageConversationItem,
  TokenUsagePoint,
  TokenUsageReport,
  TokenUsageTotals,
} from "@/lib/types"
import type { PriceTable } from "./pricing"
import { computeTokenUsageCost } from "./token-usage-cost"

const PRICES: PriceTable = {
  source: "test",
  revision: "test",
  updatedAt: null,
  models: { "claude-opus-5-5": [4, 20, 5, 8, 0.2] },
}

const M = 1e6
type Counts = [input: number, output: number, write: number, read: number]

function counts([i, o, w, r]: Counts) {
  return {
    input_tokens: i,
    output_tokens: o,
    cache_creation_tokens: w,
    cache_read_tokens: r,
    total_tokens: i + o + w + r,
    turn_count: 1,
    conversation_count: 1,
  }
}
const item = (key: string, c: Counts): TokenUsageBreakdownItem => ({
  key,
  label: key,
  ...counts(c),
})
const point = (key: string, c: Counts): TokenUsagePoint => ({
  bucket_key: key,
  start: `${key}T00:00:00Z`,
  end: `${key}T23:59:59Z`,
  ...counts(c),
})
const totals = (c: Counts): TokenUsageTotals => ({
  ...counts(c),
  duration_ms: 0,
  active_days: 1,
})

const conversation = (
  id: number,
  agent: string,
  tokens: number
): TokenUsageConversationItem => ({
  conversation_id: id,
  title: `session ${id}`,
  agent_type: agent,
  folder_label: "work",
  total_tokens: tokens,
  turn_count: 1,
  last_activity_at: "2026-10-02T00:00:00Z",
})

function report(over: Partial<TokenUsageReport>): TokenUsageReport {
  return {
    range_start: null,
    range_end: null,
    bucket: "day",
    totals: totals([0, 0, 0, 0]),
    previous_totals: null,
    series: [],
    by_folder: [],
    by_agent: [],
    by_model: [],
    heatmap: [],
    top_conversations: [],
    streak: { longest_days: 0, current_days: 0, current_ends_on: null },
    first_activity_at: null,
    last_activity_at: null,
    truncated: false,
    ...over,
  }
}

// opus 5.5 被兩個 agent 用：Claude Code（快取寫入以 1 小時計，8）與
// Cline（5 分鐘，5）。另有一個查不到單價的模型。
const opusSlice = report({
  by_agent: [
    item("claude_code", [1 * M, 1 * M, 1 * M, 10 * M]),
    item("cline", [0, 0, 1 * M, 0]),
  ],
  by_folder: [
    item("1", [1 * M, 1 * M, 1 * M, 10 * M]),
    item("2", [0, 0, 1 * M, 0]),
  ],
  series: [
    point("2026-10-01", [1 * M, 0, 2 * M, 0]),
    point("2026-10-02", [0, 1 * M, 0, 10 * M]),
  ],
  previous_totals: totals([0, 1 * M, 0, 0]),
})
const main = report({
  totals: totals([1 * M, 1 * M, 2 * M, 10 * M + 1 * M]),
  previous_totals: totals([0, 1 * M, 0, 0]),
  by_model: [
    item("claude-opus-5-5", [1 * M, 1 * M, 2 * M, 10 * M]),
    item("mystery-model", [0, 0, 0, 1 * M]),
  ],
  by_agent: [item("claude_code", [0, 0, 0, 0]), item("cline", [0, 0, 0, 0])],
  by_folder: [item("1", [0, 0, 0, 0]), item("2", [0, 0, 0, 0])],
  series: [
    point("2026-10-01", [0, 0, 0, 0]),
    point("2026-10-02", [0, 0, 0, 0]),
  ],
})

describe("computeTokenUsageCost", () => {
  const cost = computeTokenUsageCost(
    main,
    new Map([["claude-opus-5-5", opusSlice]]),
    PRICES
  )
  // claude_code：4 + 20 + 8（1 小時寫入）+ 10 × 0.2 = 34；cline：5（5 分鐘寫入）
  const claudeCode = 34
  const cline = 5

  it("prices cache writes by the agent that made them", () => {
    expect(cost.byAgent.find((r) => r.key === "claude_code")?.cost).toBeCloseTo(
      claudeCode
    )
    expect(cost.byAgent.find((r) => r.key === "cline")?.cost).toBeCloseTo(cline)
    expect(cost.byModel[0]).toMatchObject({ key: "claude-opus-5-5" })
    expect(cost.byModel[0].cost).toBeCloseTo(claudeCode + cline)
    expect(cost.total).toBeCloseTo(claudeCode + cline)
  })

  it("spreads folders and periods so they add up to the total", () => {
    const sum = (xs: { cost: number }[]) => xs.reduce((s, x) => s + x.cost, 0)
    expect(sum(cost.byFolder)).toBeCloseTo(cost.total)
    expect(sum(cost.series)).toBeCloseTo(cost.total)
    expect(cost.series.map((p) => p.key)).toEqual(["2026-10-01", "2026-10-02"])
  })

  it("lists models without a known rate instead of pricing them at zero", () => {
    expect(cost.unpriced.models).toEqual([
      { key: "mystery-model", tokens: 1 * M },
    ])
    expect(cost.unpriced.share).toBeCloseTo(1 / 15)
    expect(cost.byModel.map((r) => r.key)).not.toContain("mystery-model")
  })

  it("prices the previous period for the delta", () => {
    expect(cost.previousTotal).toBeCloseTo(20)
  })

  it("splits the cost into the four token kinds", () => {
    // 快取寫入：Claude Code 8（1 小時）+ Cline 5（5 分鐘）；快取讀取 10 × 0.2
    expect(cost.composition.input).toBeCloseTo(4)
    expect(cost.composition.output).toBeCloseTo(20)
    expect(cost.composition.cacheWrite).toBeCloseTo(13)
    expect(cost.composition.cacheRead).toBeCloseTo(2)
  })

  it("breaks every row down by token kind and by the other dimension", () => {
    const [opus] = cost.byModel
    expect(opus.composition.cacheWrite).toBeCloseTo(13)
    expect(opus.split.map((x) => x.key)).toEqual(["claude_code", "cline"])
    expect(opus.split[0].cost).toBeCloseTo(claudeCode)
    expect(opus.split[1].cost).toBeCloseTo(cline)
    expect(opus).toMatchObject({ conversations: 1, turns: 1 })

    const agent = cost.byAgent.find((r) => r.key === "cline")!
    expect(agent.split).toEqual([
      { key: "claude-opus-5-5", cost: expect.closeTo(cline) },
    ])
    expect(agent.composition.cacheWrite).toBeCloseTo(cline)

    const folder = cost.byFolder.find((r) => r.key === "1")!
    expect(folder.split.map((x) => x.key)).toEqual(["claude-opus-5-5"])
    expect(folder.split[0].cost).toBeCloseTo(folder.cost)
  })

  it("splits each period by model", () => {
    for (const point of cost.series) {
      expect(point.byModel.map((x) => x.key)).toEqual(["claude-opus-5-5"])
      expect(point.byModel[0].cost).toBeCloseTo(point.cost)
    }
  })

  it("estimates session costs at what each agent paid per token", () => {
    const withSessions = report({
      ...opusSlice,
      top_conversations: [
        conversation(8, "cline", 1 * M),
        conversation(7, "claude_code", 6.5 * M),
      ],
    })
    const { sessions } = computeTokenUsageCost(
      main,
      new Map([["claude-opus-5-5", withSessions]]),
      PRICES
    )
    // Claude Code 在 Opus 花了 34、用了 13M token；Cline 花了 5、用了 1M
    expect(sessions.map((x) => x.id)).toEqual([7, 8])
    expect(sessions[0].cost).toBeCloseTo((6.5 * 34) / 13)
    expect(sessions[1].cost).toBeCloseTo(5)
    expect(sessions[0]).toMatchObject({
      title: "session 7",
      agent: "claude_code",
      folder: "work",
      tokens: 6.5 * M,
    })
  })

  it("estimates a model whose per-model report didn't load, and says so", () => {
    const partial = computeTokenUsageCost(main, new Map(), PRICES)
    expect(partial.approximate).toBe(true)
    // 沒有 agent 細分時，快取寫入以 5 分鐘價（5）粗估：4 + 20 + 2 × 5 + 10 × 0.2
    expect(partial.total).toBeCloseTo(36)
    expect(partial.composition.cacheWrite).toBeCloseTo(10)
  })
})
