import { describe, expect, it } from "vitest"
import type { MessageTurn, TurnUsage } from "@/lib/types"
import type { PriceTable } from "./pricing"
import {
  computeSessionCost,
  loadedUsageOf,
  splitSessionUsage,
  UNKNOWN_MODEL,
  type LoadedUsage,
} from "./session-cost"

const M = 1e6
const OPUS = "claude-opus-5-5"
const SONNET = "claude-sonnet-5-5"
const PRICES: PriceTable = {
  source: "test",
  revision: "test",
  updatedAt: null,
  models: {
    [OPUS]: [5, 25, 6.25, 10, 0.5],
    [SONNET]: [3, 15, 3.75, 6, 0.3],
  },
}

const usage = (i: number, o: number, w: number, r: number): TurnUsage => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_input_tokens: w,
  cache_read_input_tokens: r,
})

let n = 0
function turn(
  role: MessageTurn["role"],
  model: string | null = null,
  u: TurnUsage | null = null
): MessageTurn {
  return {
    id: `turn-${n++}`,
    role,
    blocks: [],
    timestamp: "2026-10-08T00:00:00Z",
    model,
    usage: u,
  }
}

const loaded = (
  entries: [string, TurnUsage][],
  firstModel: string | null,
  coversStart: boolean
): LoadedUsage => ({
  perModel: new Map(entries),
  firstModel,
  coversStart,
  turns: entries.length,
})

describe("loadedUsageOf", () => {
  it("adds up each model's turns and remembers the earliest model", () => {
    const result = loadedUsageOf(
      [
        turn("user"),
        turn("assistant", SONNET, usage(1, 2, 3, 4)),
        turn("assistant", OPUS, usage(10, 20, 30, 40)),
        turn("assistant", SONNET, usage(1, 1, 1, 1)),
        // 沒記錄模型的回合另外放，還在回覆中（沒有用量）的不算
        turn("assistant", null, usage(5, 0, 0, 0)),
        turn("assistant", OPUS),
      ],
      true
    )
    expect(result.firstModel).toBe(SONNET)
    expect(result.coversStart).toBe(true)
    // 有用量的回合
    expect(result.turns).toBe(4)
    expect([...result.perModel]).toEqual([
      [SONNET, usage(2, 3, 4, 5)],
      [OPUS, usage(10, 20, 30, 40)],
      [UNKNOWN_MODEL, usage(5, 0, 0, 0)],
    ])
  })
})

describe("splitSessionUsage", () => {
  it("takes the loaded turns as-is when they add up to the session total", () => {
    const split = splitSessionUsage(
      usage(3, 3, 3, 3),
      loaded(
        [
          [OPUS, usage(2, 1, 3, 0)],
          [SONNET, usage(1, 2, 0, 3)],
        ],
        OPUS,
        true
      ),
      SONNET
    )
    expect([...split.perModel]).toEqual([
      [OPUS, usage(2, 1, 3, 0)],
      [SONNET, usage(1, 2, 0, 3)],
    ])
    expect(split.restModel).toBeNull()
    expect(split.complete).toBe(true)
  })

  it("prices turns that aren't loaded as the earliest loaded model", () => {
    // 已載入的回合從中間開始：多出來的是較早的回合
    const single = splitSessionUsage(
      usage(10, 0, 0, 0),
      loaded([[OPUS, usage(4, 0, 0, 0)]], OPUS, false),
      SONNET
    )
    expect([...single.perModel]).toEqual([[OPUS, usage(10, 0, 0, 0)]])
    // 只用過一個模型：沒有換過模型的跡象，不算推定
    expect(single.complete).toBe(true)

    const mixed = splitSessionUsage(
      usage(10, 0, 0, 0),
      loaded(
        [
          [SONNET, usage(1, 0, 0, 0)],
          [OPUS, usage(4, 0, 0, 0)],
        ],
        SONNET,
        false
      ),
      OPUS
    )
    expect(mixed.perModel.get(SONNET)).toEqual(usage(6, 0, 0, 0))
    expect(mixed.perModel.get(OPUS)).toEqual(usage(4, 0, 0, 0))
    expect(mixed.restModel).toBe(SONNET)
    expect(mixed.complete).toBe(false)
  })

  it("prices usage not yet on the loaded turns as the current model", () => {
    // 已載入的回合涵蓋開頭：多出來的只會是最新、還沒補上用量的回合
    const split = splitSessionUsage(
      usage(10, 5, 0, 0),
      loaded([[SONNET, usage(4, 5, 0, 0)]], SONNET, true),
      OPUS
    )
    expect(split.perModel.get(OPUS)).toEqual(usage(6, 0, 0, 0))
    expect(split.perModel.get(SONNET)).toEqual(usage(4, 5, 0, 0))
    expect(split.restModel).toBe(OPUS)
    expect(split.complete).toBe(true)
  })

  it("scales the loaded turns down to the total when they run ahead of it", () => {
    const split = splitSessionUsage(
      usage(6, 0, 0, 0),
      loaded(
        [
          [OPUS, usage(6, 0, 0, 0)],
          [SONNET, usage(3, 0, 0, 0)],
        ],
        OPUS,
        true
      ),
      OPUS
    )
    expect(split.perModel.get(OPUS)?.input_tokens).toBe(4)
    expect(split.perModel.get(SONNET)?.input_tokens).toBe(2)
    expect(split.restModel).toBeNull()
  })

  it("puts turns without a model, or nothing loaded, on the current model", () => {
    const unknown = splitSessionUsage(
      usage(2, 0, 0, 0),
      loaded([[UNKNOWN_MODEL, usage(2, 0, 0, 0)]], null, true),
      OPUS
    )
    expect([...unknown.perModel]).toEqual([[OPUS, usage(2, 0, 0, 0)]])

    const nothing = loaded([], null, true)
    expect([
      ...splitSessionUsage(usage(1, 1, 1, 1), nothing, OPUS).perModel,
    ]).toEqual([[OPUS, usage(1, 1, 1, 1)]])
    // 連目前的模型都不知道：留在 UNKNOWN_MODEL，之後列為未計價
    expect([
      ...splitSessionUsage(usage(1, 1, 1, 1), nothing, null).perModel.keys(),
    ]).toEqual([UNKNOWN_MODEL])
  })
})

describe("computeSessionCost", () => {
  const cost = computeSessionCost(
    new Map([
      [OPUS, usage(2 * M, 1 * M, 0.5 * M, 30 * M)],
      [SONNET, usage(1 * M, 1 * M, 0, 0)],
      [UNKNOWN_MODEL, usage(7, 0, 0, 0)],
    ]),
    "claude_code",
    PRICES
  )

  it("prices each model and splits the cost into the four token kinds", () => {
    // Opus：10 + 25 + 0.5 × 10（Claude Code 的快取寫入以 1 小時計）+ 30 × 0.5 = 55
    // Sonnet：3 + 15 = 18
    expect(cost.byModel.map((m) => m.model)).toEqual([OPUS, SONNET])
    expect(cost.byModel[0].cost).toBeCloseTo(55)
    expect(cost.byModel[1].cost).toBeCloseTo(18)
    expect(cost.total).toBeCloseTo(73)
    expect(cost.composition.input).toBeCloseTo(13)
    expect(cost.composition.output).toBeCloseTo(40)
    expect(cost.composition.cacheWrite).toBeCloseTo(5)
    expect(cost.composition.cacheRead).toBeCloseTo(15)
    expect(cost.ttl).toBe("1h")
  })

  it("keeps each model's tokens, rates and per-kind cost for the breakdown", () => {
    const [opus] = cost.byModel
    expect(opus.usage).toEqual(usage(2 * M, 1 * M, 0.5 * M, 30 * M))
    expect(opus.rates).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 10,
      cacheRead: 0.5,
    })
    expect(opus.parts.cacheWrite).toBeCloseTo(5)
    expect(opus.parts.cacheRead).toBeCloseTo(15)
  })

  it("lists usage it can't price instead of counting it as free", () => {
    expect(cost.unpriced).toEqual([{ model: UNKNOWN_MODEL, tokens: 7 }])
  })
})
