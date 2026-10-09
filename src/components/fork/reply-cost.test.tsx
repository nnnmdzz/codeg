import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import type { TurnUsage } from "@/lib/types"

vi.mock("@/lib/fork/pricing/pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork/pricing/pricing")>()),
  loadPriceTable: async () => ({
    source: "test",
    revision: "test",
    updatedAt: null,
    models: { "claude-opus-5-5": [5, 25, 6.25, 10, 0.5] },
  }),
}))

import { ReplyCost, ReplyCostAgentProvider } from "./reply-cost"

const M = 1e6
// 輸入 5 + 輸出 25 + 快取讀取 30 × 0.5；快取寫入 0.4M 依 agent 而定
const USAGE: TurnUsage = {
  input_tokens: 1 * M,
  output_tokens: 1 * M,
  cache_creation_input_tokens: 0.4 * M,
  cache_read_input_tokens: 30 * M,
}

function renderCost(node: ReactNode, agent: string | null = "claude_code") {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <ReplyCostAgentProvider value={agent}>{node}</ReplyCostAgentProvider>
    </NextIntlClientProvider>
  )
}

describe("ReplyCost", () => {
  it("prices the reply, with Claude Code's 1-hour cache writes", async () => {
    renderCost(<ReplyCost usage={USAGE} model="claude-opus-5-5" />)
    // 0.4 × 10 = 4
    expect(await screen.findByText("$49.00")).toBeInTheDocument()
  })

  it("prices other agents' cache writes at the 5-minute rate", async () => {
    renderCost(<ReplyCost usage={USAGE} model="claude-opus-5-5" />, "cline")
    // 0.4 × 6.25 = 2.5
    expect(await screen.findByText("$47.50")).toBeInTheDocument()
  })

  it("marks a reply that used several models as an estimate", async () => {
    renderCost(
      <ReplyCost
        usage={USAGE}
        model="claude-opus-5-5"
        models={["claude-opus-5-5", "claude-haiku-4-5"]}
      />
    )
    expect(await screen.findByText("≈ $49.00")).toBeInTheDocument()
  })

  it("shows nothing for a model without a known rate", async () => {
    const { container } = renderCost(
      <>
        <ReplyCost usage={USAGE} model="mystery-model" />
        <ReplyCost usage={USAGE} model="claude-opus-5-5" />
      </>
    )
    // 等單價表載入（第二個顯示出來），第一個仍然是空的
    await screen.findByText("$49.00")
    expect(container.querySelectorAll("span")).toHaveLength(1)
  })
})
