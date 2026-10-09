import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  TokenUsageBreakdownItem,
  TokenUsageFilter,
  TokenUsageReport,
} from "@/lib/types"

const M = 1e6
const counts = (i: number, o: number, w: number, r: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_tokens: w,
  cache_read_tokens: r,
  total_tokens: i + o + w + r,
  turn_count: 1,
  conversation_count: 1,
})
const item = (
  key: string,
  ...c: [number, number, number, number]
): TokenUsageBreakdownItem => ({ key, label: key, ...counts(...c) })

function report(over: Partial<TokenUsageReport>): TokenUsageReport {
  return {
    range_start: null,
    range_end: null,
    bucket: "day",
    totals: { ...counts(0, 0, 0, 0), duration_ms: 0, active_days: 1 },
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

const opus = report({
  by_agent: [item("claude_code", M, M, M, 10 * M), item("cline", 0, 0, M, 0)],
  top_conversations: [
    {
      conversation_id: 7,
      title: "Fix login",
      agent_type: "claude_code",
      folder_label: "work",
      total_tokens: 6.5 * M,
      turn_count: 4,
      last_activity_at: "2026-10-01T09:00:00Z",
    },
  ],
  by_folder: [item("1", M, M, 2 * M, 10 * M)],
  series: [
    {
      bucket_key: "2026-10-01",
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-02T00:00:00Z",
      ...counts(M, M, 2 * M, 10 * M),
    },
  ],
})
const main = report({
  totals: { ...counts(M, M, 2 * M, 11 * M), duration_ms: 0, active_days: 1 },
  by_model: [
    item("claude-opus-5-5", M, M, 2 * M, 10 * M),
    item("mystery-model", 0, 0, 0, M),
  ],
  by_agent: [item("claude_code", 0, 0, 0, 0), item("cline", 0, 0, 0, 0)],
  by_folder: [item("1", 0, 0, 0, 0)],
  series: opus.series,
})

const tokenUsageReport = vi.hoisted(() =>
  vi.fn(async (filter: TokenUsageFilter) => {
    if (filter.models?.[0] === "claude-opus-5-5") return opus
    throw new Error("unexpected model")
  })
)
// 會話 7 的總用量：1M 輸入、0.25M 輸出、0.25M 快取寫入、5M 快取讀取（6.5M）
const getFolderConversation = vi.hoisted(() =>
  vi.fn(async (id: number) => ({
    summary: { id },
    turns: [],
    session_stats: {
      total_usage: {
        input_tokens: 1_000_000,
        output_tokens: 250_000,
        cache_creation_input_tokens: 250_000,
        cache_read_input_tokens: 5_000_000,
      },
      total_duration_ms: 0,
    },
  }))
)
vi.mock("@/lib/api", () => ({ tokenUsageReport, getFolderConversation }))
vi.mock("@/lib/fork/pricing/pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork/pricing/pricing")>()),
  loadPriceTable: async () => ({
    source: "https://example.test/prices.json",
    revision: "abc1234",
    updatedAt: "2026-10-09T00:00:00Z",
    models: { "claude-opus-5-5": [4, 20, 5, 8, 0.2] },
  }),
}))

import enMessages from "@/i18n/messages/en.json"
import {
  resetCostSliceCache,
  resetSessionTotalsCache,
  TokenUsageCostSection,
} from "./token-usage-cost-section"

const FILTER = {
  start: "2026-10-01T00:00:00Z",
  end: null,
  folderIds: null,
  agentTypes: null,
  bucket: "day" as const,
  tzOffsetMinutes: 480,
}

function section(r: TokenUsageReport) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TokenUsageCostSection report={r} filter={FILTER} />
    </NextIntlClientProvider>
  )
}

function renderSection() {
  return render(section(main))
}

describe("TokenUsageCostSection", () => {
  beforeEach(() => {
    resetCostSliceCache()
    resetSessionTotalsCache()
    tokenUsageReport.mockClear()
    getFolderConversation.mockClear()
  })

  it("prices each model through its own report and shows the total", async () => {
    renderSection()
    // claude_code 34（1 小時快取寫入）+ cline 5（5 分鐘）= 39
    // 總數、最高區段（只有一天）與模型那一列都是 $39.00
    expect((await screen.findAllByText("$39.00")).length).toBe(3)
    expect(tokenUsageReport).toHaveBeenCalledWith({
      ...FILTER,
      models: ["claude-opus-5-5"],
      comparePrevious: false,
    })
    // 查不到單價的模型不另外查，也不當成 0 元
    expect(tokenUsageReport).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/mystery-model/)).toHaveTextContent(
      "Not priced: mystery-model (6.7% of tokens)"
    )
    expect(
      screen.getByRole("link", { name: "Rates: LiteLLM 2026-10-09" })
    ).toHaveAttribute("href", "https://example.test/prices.json")
  })

  it("shows what each token kind cost", async () => {
    renderSection()
    await screen.findAllByText("$39.00")
    expect(
      screen.getByRole("img", { name: "Cost composition" })
    ).toBeInTheDocument()
    // 輸入 4、輸出 20、快取寫入 8 + 5、快取讀取 2
    for (const value of ["$4.00", "$20.00", "$13.00", "$2.00"]) {
      expect(screen.getByText(value)).toBeInTheDocument()
    }
  })

  it("reuses per-model reports until the data changes", async () => {
    const { rerender } = renderSection()
    await screen.findAllByText("$39.00")
    expect(tokenUsageReport).toHaveBeenCalledTimes(1)

    // 頁面重新整理拿到同樣的數字（新的物件）：不重查
    rerender(section({ ...main }))
    await waitFor(() =>
      expect(screen.queryByLabelText("Computing costs…")).toBeNull()
    )
    expect(tokenUsageReport).toHaveBeenCalledTimes(1)

    // 有新的用量：重查
    rerender(section({ ...main, last_activity_at: "2026-10-08T09:00:00Z" }))
    await waitFor(() => expect(tokenUsageReport).toHaveBeenCalledTimes(2))
  })

  it("opens a model into its kinds, agents and unit costs", async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findAllByText("$39.00")
    const row = screen.getByRole("button", { name: /claude-opus-5-5/ })
    expect(row).toHaveAttribute("aria-expanded", "false")
    await user.click(row)
    expect(row).toHaveAttribute("aria-expanded", "true")
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!
    expect(detail).toHaveTextContent("Agents: Claude Code $34.00 · Cline $5.00")
    expect(detail).toHaveTextContent(
      "1 session, $39.00 each on average, 1 turn, $39.00 per turn"
    )
    expect(
      within(detail).getByRole("img", { name: "Cost composition" })
    ).toBeInTheDocument()
    await user.click(row)
    expect(row).toHaveAttribute("aria-expanded", "false")
  })

  it("ranks sessions, replacing the estimate with the session's own usage", async () => {
    const user = userEvent.setup()
    // 會話用量先不回來，看得到估算
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const answer = getFolderConversation.getMockImplementation()!
    getFolderConversation.mockImplementationOnce(async (id: number) => {
      await held
      return answer(id)
    })
    renderSection()
    await screen.findAllByText("$39.00")
    // 沒打開「會話」分組前不讀會話
    expect(getFolderConversation).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Session" }))
    // 先估算：Claude Code 在 Opus 每 13M token 花 34，6.5M ≈ 17
    expect(screen.getByText("Fix login")).toBeInTheDocument()
    expect(screen.getByText("≈ $17.00")).toBeInTheDocument()
    expect(screen.getByText("Claude Code · work")).toBeInTheDocument()
    expect(
      screen.getByText("≈ marks sessions estimated by token share.")
    ).toBeInTheDocument()
    // 讀到會話用量：整段都在期間內、只用 Opus，4 + 5 + 0.25 × 8 + 5 × 0.2
    await act(async () => release())
    expect(await screen.findByText("$12.00")).toBeInTheDocument()
    expect(screen.queryByText("≈ $17.00")).toBeNull()
    expect(getFolderConversation).toHaveBeenCalledWith(7, {
      fromIndex: Number.MAX_SAFE_INTEGER,
    })
  })

  it("breaks the cost down by agent", async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findAllByText("$39.00")
    await user.click(screen.getByRole("button", { name: "Agent" }))
    await waitFor(() => expect(screen.getByText("$34.00")).toBeInTheDocument())
    expect(screen.getByText("$5.00")).toBeInTheDocument()
  })
})
