import { describe, expect, it } from "vitest"
import type { TurnUsage } from "@/lib/types"
import type { PriceTable } from "./pricing"
import { refineSessionCost } from "./session-refine"
import type { SessionCost } from "./token-usage-cost"

const M = 1e6
const OPUS = "claude-opus-5-5"
const SONNET = "claude-sonnet-5-5"
const PRICES: PriceTable = {
  source: "test",
  revision: "test",
  updatedAt: null,
  models: {
    [OPUS]: [4, 20, 5, 8, 0.2],
    [SONNET]: [2, 10, 2.5, 4, 0.1],
  },
}

const usage = (i: number, o: number, w: number, r: number): TurnUsage => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_input_tokens: w,
  cache_read_input_tokens: r,
})

function session(
  models: [string, number][],
  agent = "claude_code"
): SessionCost {
  return {
    id: 7,
    title: "s",
    agent,
    folder: null,
    lastActivityAt: "2026-10-08T00:00:00Z",
    tokens: models.reduce((sum, [, t]) => sum + t, 0),
    models: models.map(([key, tokens]) => ({ key, tokens })),
    cost: 0,
  }
}

// 1M 輸入、0.25M 輸出、0.25M 快取寫入、5M 快取讀取，共 6.5M
const TOTAL = usage(1 * M, 0.25 * M, 0.25 * M, 5 * M)

describe("refineSessionCost", () => {
  it("prices a session that sits wholly in the range exactly", () => {
    // 4 + 5 + 0.25 × 8（Claude Code 的快取寫入以 1 小時計）+ 5 × 0.2
    expect(
      refineSessionCost(session([[OPUS, 6.5 * M]]), TOTAL, PRICES)
    ).toEqual({ cost: expect.closeTo(12), exact: true })
    // 其他 agent 以 5 分鐘計
    expect(
      refineSessionCost(session([[OPUS, 6.5 * M]], "cline"), TOTAL, PRICES)
        ?.cost
    ).toBeCloseTo(4 + 5 + 0.25 * 5 + 1)
  })

  it("keeps only the share inside the range for a session that began before it", () => {
    const result = refineSessionCost(session([[OPUS, 3.25 * M]]), TOTAL, PRICES)
    expect(result).toEqual({ cost: expect.closeTo(6), exact: false })
  })

  it("splits a session across its models by tokens", () => {
    const result = refineSessionCost(
      session([
        [OPUS, 5.2 * M],
        [SONNET, 1.3 * M],
      ]),
      TOTAL,
      PRICES
    )
    // 八成以 Opus 計、兩成以 Sonnet 計
    expect(result?.cost).toBeCloseTo(12 * 0.8 + (2 + 2.5 + 1 + 0.5) * 0.2)
    expect(result?.exact).toBe(false)
  })

  it("gives up when either side has no usage", () => {
    expect(
      refineSessionCost(session([[OPUS, 1 * M]]), usage(0, 0, 0, 0), PRICES)
    ).toBeNull()
    expect(refineSessionCost(session([]), TOTAL, PRICES)).toBeNull()
  })
})
