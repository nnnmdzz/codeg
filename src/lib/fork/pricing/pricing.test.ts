import { describe, expect, it } from "vitest"
import {
  cacheTtlForAgent,
  cacheWriteRate,
  loadPriceTable,
  modelPriceCandidates,
  resolveModelPrice,
  tokenCost,
  type ModelPrice,
  type PriceTable,
} from "./pricing"

const TABLE: PriceTable = {
  source: "test",
  revision: "test",
  updatedAt: null,
  models: {
    "claude-opus-5-5": [4, 20, 5, 8, 0.2],
    "claude-old": [3, 15, 3.75, null, 0.3],
    "gpt-5.3-codex": [1.75, 14, null, null, 0.175],
    "gemini-2.5-pro": [1.25, 10, null, null, 0.125],
  },
}

describe("model name matching", () => {
  it("strips context suffixes, provider prefixes and dates", () => {
    expect(modelPriceCandidates("claude-opus-5-5[1m]")).toContain(
      "claude-opus-5-5"
    )
    expect(
      modelPriceCandidates("anthropic/claude-opus-5-5-20260301")
    ).toContain("claude-opus-5-5")
    expect(modelPriceCandidates("Gemini/Gemini-2.5-Pro")).toContain(
      "gemini-2.5-pro"
    )
  })

  it("resolves known models and leaves unknown ones unpriced", () => {
    expect(resolveModelPrice("claude-opus-5-5[1m]", TABLE)?.input).toBe(4)
    expect(resolveModelPrice("GPT-5.3-Codex", TABLE)?.output).toBe(14)
    expect(resolveModelPrice("mystery-model", TABLE)).toBeNull()
    expect(resolveModelPrice("__unknown__", TABLE)).toBeNull()
  })
})

describe("cache write rate", () => {
  const price = (row: PriceTable["models"][string]): ModelPrice =>
    resolveModelPrice("x", { ...TABLE, models: { x: row } })!

  it("uses the 1-hour rate for Claude Code and the 5-minute rate otherwise", () => {
    expect(cacheTtlForAgent("claude_code")).toBe("1h")
    expect(cacheTtlForAgent("cline")).toBe("5m")
    const opus = price(TABLE.models["claude-opus-5-5"])
    expect(cacheWriteRate(opus, "1h")).toBe(8)
    expect(cacheWriteRate(opus, "5m")).toBe(5)
  })

  it("falls back to twice the input rate when the 1-hour rate is missing", () => {
    expect(cacheWriteRate(price(TABLE.models["claude-old"]), "1h")).toBe(6)
  })

  it("charges the input rate when the model has no cache-write pricing", () => {
    const codex = price(TABLE.models["gpt-5.3-codex"])
    expect(cacheWriteRate(codex, "1h")).toBe(1.75)
    expect(cacheWriteRate(codex, "5m")).toBe(1.75)
  })
})

describe("tokenCost", () => {
  it("prices each of the four token kinds per million", () => {
    const opus = resolveModelPrice("claude-opus-5-5", TABLE)!
    const million = {
      input_tokens: 1e6,
      output_tokens: 1e6,
      cache_creation_tokens: 1e6,
      cache_read_tokens: 1e6,
    }
    expect(tokenCost(million, opus, 8)).toBeCloseTo(4 + 20 + 8 + 0.2, 10)
  })
})

describe("price snapshot", () => {
  it("loads and covers the models in daily use", async () => {
    const prices = await loadPriceTable()
    expect(prices.source).toContain("litellm")
    for (const model of [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "gpt-5.3-codex",
    ]) {
      expect(resolveModelPrice(model, prices)).not.toBeNull()
    }
  })
})
