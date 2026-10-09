import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  DbConversationSummary,
  MessageTurn,
  SessionStats,
  TurnUsage,
} from "@/lib/types"

const M = 1e6
const OPUS = "claude-opus-5-5"
const SONNET = "claude-sonnet-5-5"

// 執行期狀態：會話 id → 已載入的時間軸與視窗起點
const runtime = vi.hoisted(() => ({
  sessions: new Map<number, { turns: unknown[]; turnsOffset: number }>(),
  tabs: [] as {
    conversationId: number | null
    runtimeConversationId?: number
  }[],
}))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: (select: (state: unknown) => unknown) =>
    select({
      byConversationId: new Map(
        [...runtime.sessions].map(([id, s]) => [
          id,
          { detail: { turns_offset: s.turnsOffset } },
        ])
      ),
    }),
  selectTimelineTurns: (_state: unknown, id: number) =>
    (runtime.sessions.get(id)?.turns ?? []).map((turn) => ({
      key: (turn as MessageTurn).id,
      turn,
      phase: "persisted",
    })),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (select: (state: unknown) => unknown) =>
    select({ tabs: runtime.tabs }),
}))
vi.mock("@/lib/fork/pricing/pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fork/pricing/pricing")>()),
  loadPriceTable: async () => ({
    source: "https://example.test/prices.json",
    revision: "abc1234",
    updatedAt: "2026-10-09T00:00:00Z",
    models: {
      [OPUS]: [5, 25, 6.25, 10, 0.5],
      [SONNET]: [3, 15, 3.75, 6, 0.3],
    },
  }),
}))

import enMessages from "@/i18n/messages/en.json"
import { SessionCostSection } from "./session-cost-section"

const usage = (i: number, o: number, w: number, r: number): TurnUsage => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_input_tokens: w,
  cache_read_input_tokens: r,
})
const stats = (u: TurnUsage): SessionStats => ({
  total_usage: u,
  total_duration_ms: 0,
})
let n = 0
const turn = (model: string | null, u: TurnUsage | null): MessageTurn => ({
  id: `turn-${n++}`,
  role: model ? "assistant" : "user",
  blocks: [],
  timestamp: "2026-10-08T00:00:00Z",
  model,
  usage: u,
})

const SUMMARY: DbConversationSummary = {
  id: 7,
  folder_id: 1,
  title: "My session",
  title_locked: false,
  agent_type: "claude_code",
  status: "completed",
  kind: "regular",
  model: null,
  git_branch: null,
  external_id: null,
  message_count: 4,
  child_count: 0,
  created_at: "2026-10-08T00:00:00Z",
  updated_at: "2026-10-08T00:00:00Z",
  pinned_at: null,
}

// Opus：10 + 25 + 0.5 × 10（1 小時快取寫入）+ 30 × 0.5 = 55；Sonnet：3 + 15 = 18
const OPUS_USAGE = usage(2 * M, 1 * M, 0.5 * M, 30 * M)
const SONNET_USAGE = usage(1 * M, 1 * M, 0, 0)
const BOTH = usage(3 * M, 2 * M, 0.5 * M, 30 * M)
const TWO_MODEL_TURNS = [
  turn(null, null),
  turn(OPUS, OPUS_USAGE),
  turn(null, null),
  turn(SONNET, SONNET_USAGE),
]

function renderSection(total: TurnUsage, model: string | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionCostSection
        summary={SUMMARY}
        stats={stats(total)}
        model={model}
        active
      />
    </NextIntlClientProvider>
  )
}

describe("SessionCostSection", () => {
  beforeEach(() => {
    runtime.sessions.clear()
    runtime.tabs = []
  })

  it("prices a session that isn't open at its model, without fetching", async () => {
    renderSection(OPUS_USAGE, OPUS)
    // 總計與模型那一列
    expect(await screen.findAllByText("$55.00")).toHaveLength(2)
    expect(
      screen.getByRole("img", { name: "Cost composition" })
    ).toBeInTheDocument()
    // 只有一個模型也列出來，底下是「數量 × 單價 = 金額」
    expect(screen.getByText(OPUS)).toBeInTheDocument()
    expect(screen.getByText("2M × $5/M")).toBeInTheDocument()
    expect(screen.getByText("$10.00")).toBeInTheDocument()
    expect(screen.getByText("1M × $25/M")).toBeInTheDocument()
    expect(screen.getByText("$25.00")).toBeInTheDocument()
    expect(screen.getByText("500K × $10/M")).toBeInTheDocument()
    expect(screen.getByText("$5.00")).toBeInTheDocument()
    expect(screen.getByText("30M × $0.50/M")).toBeInTheDocument()
    expect(screen.getByText("$15.00")).toBeInTheDocument()
    // 會話沒開著，不知道回合數
    expect(screen.queryByText(/per turn/)).toBeNull()
  })

  it("splits an open session by the models its loaded turns used", async () => {
    // 新會話在執行期狀態裡用分頁的暫時 id
    runtime.tabs = [{ conversationId: 7, runtimeConversationId: -3 }]
    runtime.sessions.set(-3, { turns: TWO_MODEL_TURNS, turnsOffset: 0 })
    renderSection(BOTH, SONNET)
    expect(await screen.findByText("$73.00")).toBeInTheDocument()
    expect(screen.getByText(OPUS)).toBeInTheDocument()
    expect(screen.getByText(SONNET)).toBeInTheDocument()
    expect(screen.getByText("$55.00")).toBeInTheDocument()
    expect(screen.getByText("$18.00")).toBeInTheDocument()
    expect(screen.getByText("75%")).toBeInTheDocument()
    expect(screen.getByText("25%")).toBeInTheDocument()
    // 已載入的回合涵蓋整個會話：兩個有用量的回合
    expect(
      screen.getByText("2 turns, $36.50 per turn on average")
    ).toBeInTheDocument()
    expect(screen.queryByText(/figures are estimates/)).toBeNull()
  })

  it("marks the total as an estimate when earlier turns aren't loaded", async () => {
    runtime.sessions.set(7, { turns: TWO_MODEL_TURNS, turnsOffset: 40 })
    // 未載入的較早回合多了 1M 輸入，以已載入回合中最早的模型（Opus）計
    renderSection(usage(4 * M, 2 * M, 0.5 * M, 30 * M), SONNET)
    expect(await screen.findByText("≈ $78.00")).toBeInTheDocument()
    expect(
      screen.getByText(`Earlier unloaded turns priced as ${OPUS}`)
    ).toBeInTheDocument()
  })

  it("shows nothing when the session has no usage", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SessionCostSection
          summary={SUMMARY}
          stats={null}
          model={OPUS}
          active
        />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
