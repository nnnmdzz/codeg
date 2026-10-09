"use client"

// mobile fork：會話詳情的「費用」區塊（美元，API 牌價等值）。不送上游。
//
// 金額以會話詳情拿到的總用量為準；依模型的拆分取自執行期狀態裡已載入的回合
// （開著的會話的時間軸），不另外讀網路（見 @/lib/fork/pricing/session-cost）。
// 與會話詳情的耦合只有它傳進來的摘要、統計、模型與是否顯示中；版面沿用它的
// InfoItem。
//
// 每個計價的模型都列出來（只有一個也列，才看得出以哪個模型計價），底下是
// 四類 token 的「數量 × 單價 = 金額」，算法一目了然。
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { useLocale } from "next-intl"
import { useTabStore } from "@/contexts/tab-context"
import { useModelLabels } from "@/hooks/use-model-labels"
import { formatRate, formatUsd } from "@/lib/fork/pricing/format"
import { loadPriceTable, type PriceTable } from "@/lib/fork/pricing/pricing"
import {
  computeSessionCost,
  loadedUsageOf,
  splitSessionUsage,
  UNKNOWN_MODEL,
  type LoadedUsage,
} from "@/lib/fork/pricing/session-cost"
import {
  CostComposition,
  KIND_COLORS,
} from "@/components/fork/cost-composition"
import { formatTokenCount } from "@/lib/token-format"
import type {
  DbConversationSummary,
  SessionStats,
  TurnUsage,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  selectTimelineTurns,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-TW": {
    heading: "費用（API 牌價等值）",
    total: "總計",
    approx: "約",
    kinds: {
      input: "輸入",
      output: "輸出",
      cacheWrite: "快取寫入",
      cacheRead: "快取讀取",
    },
    turns: (_n: number, count: string, v: string) =>
      `${count} 回合，平均每回合 ${v}`,
    loading: "計算費用中…",
    failed: "費用計算失敗",
    unknownModel: "未記錄模型",
    note: (ttl: string, source: string) =>
      `以官方 API 單價換算（${source}），不是實際帳單。單價為每百萬 token；快取寫入以 ${ttl} 計。`,
    ttl: { "1h": "1 小時", "5m": "5 分鐘" },
    unpriced: (list: string) => `未計價（查不到單價）：${list}`,
    assumed: (model: string) =>
      `較早、未載入的回合以 ${model} 計，金額為估計值。`,
    sep: "、",
  },
  "zh-CN": {
    heading: "费用（API 牌价等值）",
    total: "总计",
    approx: "约",
    kinds: {
      input: "输入",
      output: "输出",
      cacheWrite: "缓存写入",
      cacheRead: "缓存读取",
    },
    turns: (_n: number, count: string, v: string) =>
      `${count} 轮，平均每轮 ${v}`,
    loading: "计算费用中…",
    failed: "费用计算失败",
    unknownModel: "未记录模型",
    note: (ttl: string, source: string) =>
      `以官方 API 单价换算（${source}），不是实际账单。单价为每百万 token；缓存写入以 ${ttl} 计。`,
    ttl: { "1h": "1 小时", "5m": "5 分钟" },
    unpriced: (list: string) => `未计价（查不到单价）：${list}`,
    assumed: (model: string) =>
      `较早、未载入的回合以 ${model} 计，金额为估计值。`,
    sep: "、",
  },
  en: {
    heading: "Cost (API list-price equivalent)",
    total: "Total",
    approx: "≈",
    kinds: {
      input: "Input",
      output: "Output",
      cacheWrite: "Cache write",
      cacheRead: "Cache read",
    },
    turns: (n: number, count: string, v: string) =>
      `${count} ${n === 1 ? "turn" : "turns"}, ${v} per turn on average`,
    loading: "Computing cost…",
    failed: "Couldn't compute the cost",
    unknownModel: "No model recorded",
    note: (ttl: string, source: string) =>
      `Priced at official API rates (${source}) — not your bill. Rates are per million tokens; cache writes at the ${ttl} rate.`,
    ttl: { "1h": "1-hour", "5m": "5-minute" },
    unpriced: (list: string) => `Not priced (no known rate): ${list}`,
    assumed: (model: string) =>
      `Earlier turns that aren't loaded are priced as ${model}; the figures are estimates.`,
    sep: ", ",
  },
} as const

/** 與會話詳情的 InfoItem 同一個樣子。不直接 import，免得兩個檔案互相引用。 */
function InfoItem({
  label,
  children,
  valueClassName,
}: {
  label: ReactNode
  children: ReactNode
  valueClassName?: string
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("min-w-0 leading-snug", valueClassName)}>{children}</dd>
    </div>
  )
}

function useCopy() {
  const locale = useLocale()
  return locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
}

type RuntimeState = Parameters<typeof selectTimelineTurns>[0]

/**
 * 已載入回合依模型的用量，序列化成字串：執行期狀態在串流時每秒變動數十次，
 * 字串相同就不會重新 render，只有數字真的變了才會。
 */
function loadedUsageKey(state: RuntimeState, runtimeId: number): string {
  const session = state.byConversationId.get(runtimeId)
  if (!session) return ""
  const loaded = loadedUsageOf(
    selectTimelineTurns(state, runtimeId).map((item) => item.turn),
    (session.detail?.turns_offset ?? 0) === 0
  )
  return JSON.stringify([
    loaded.coversStart,
    loaded.firstModel,
    loaded.turns,
    [...loaded.perModel],
  ])
}

function parseLoadedUsage(key: string): LoadedUsage | null {
  if (!key) return null
  const [coversStart, firstModel, turns, perModel] = JSON.parse(key) as [
    boolean,
    string | null,
    number,
    [string, TurnUsage][],
  ]
  return { coversStart, firstModel, turns, perModel: new Map(perModel) }
}

/** 沒有執行期狀態（會話沒開著）：全部以目前的模型計 */
const NOTHING_LOADED: LoadedUsage = {
  perModel: new Map(),
  firstModel: null,
  coversStart: true,
  turns: 0,
}

const KINDS = [
  { key: "input", tokens: "input_tokens" },
  { key: "output", tokens: "output_tokens" },
  { key: "cacheWrite", tokens: "cache_creation_input_tokens" },
  { key: "cacheRead", tokens: "cache_read_input_tokens" },
] as const

export function SessionCostSection({
  summary,
  stats,
  model,
  active,
}: {
  summary: DbConversationSummary
  stats: SessionStats | null
  model: string | null
  active: boolean
}) {
  const copy = useCopy()
  const locale = useLocale()
  const modelLabel = useModelLabels(summary.agent_type)
  const usage = stats?.total_usage ?? null
  const hasUsage = usage !== null

  // 新會話在執行期狀態裡用分頁的暫時 id，不是會話 id
  const runtimeId =
    useTabStore(
      (s) =>
        s.tabs.find((tab) => tab.conversationId === summary.id)
          ?.runtimeConversationId
    ) ?? summary.id
  const loadedKey = useConversationRuntimeStore((s) =>
    active && hasUsage ? loadedUsageKey(s, runtimeId) : ""
  )
  const loaded = useMemo(() => parseLoadedUsage(loadedKey), [loadedKey])

  const [prices, setPrices] = useState<PriceTable | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active || !hasUsage || prices) return
    let cancelled = false
    loadPriceTable()
      .then((table) => {
        if (!cancelled) setPrices(table)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [active, hasUsage, prices])

  const result = useMemo(() => {
    if (!prices || !usage) return null
    const split = splitSessionUsage(usage, loaded ?? NOTHING_LOADED, model)
    return {
      split,
      cost: computeSessionCost(split.perModel, summary.agent_type, prices),
    }
  }, [prices, usage, loaded, model, summary.agent_type])

  if (!usage) return null
  const name = (m: string) =>
    m === UNKNOWN_MODEL ? copy.unknownModel : (modelLabel(m) ?? m)
  const numeric = "font-mono tabular-nums"

  return (
    <section className="min-w-0 space-y-3 border-t pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {copy.heading}
      </h3>
      {!result ? (
        failed ? (
          <div className="text-muted-foreground">{copy.failed}</div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {copy.loading}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <dl>
            <InfoItem
              label={copy.total}
              valueClassName={`${numeric} text-base font-semibold`}
            >
              {!result.split.complete && `${copy.approx} `}
              {formatUsd(result.cost.total, locale)}
            </InfoItem>
          </dl>
          <CostComposition
            parts={result.cost.composition}
            // 只有一個模型時，下面的明細就是圖例
            legend={result.cost.byModel.length > 1}
          />
          <ul className="tu-viz space-y-3">
            {result.cost.byModel.map((m) => (
              <li key={m.model} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {name(m.model)}
                  </span>
                  <span className={`shrink-0 ${numeric}`}>
                    {formatUsd(m.cost, locale)}
                  </span>
                  {result.cost.byModel.length > 1 && (
                    <span className="w-9 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                      {result.cost.total > 0
                        ? `${Math.round((m.cost / result.cost.total) * 100)}%`
                        : ""}
                    </span>
                  )}
                </div>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 gap-y-1 text-xs">
                  {KINDS.filter((k) => m.usage[k.tokens] > 0).map((k) => (
                    <div key={k.key} className="contents">
                      <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: KIND_COLORS[k.key] }}
                        />
                        {copy.kinds[k.key]}
                      </dt>
                      <dd className="min-w-0 truncate text-right font-mono tabular-nums text-muted-foreground">
                        {formatTokenCount(m.usage[k.tokens])} ×{" "}
                        {formatRate(m.rates[k.key], locale)}
                      </dd>
                      <dd className="text-right font-mono tabular-nums">
                        {formatUsd(m.parts[k.key], locale)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          {loaded?.coversStart && loaded.turns > 0 && (
            <p className="text-xs text-muted-foreground">
              {copy.turns(
                loaded.turns,
                loaded.turns.toLocaleString(locale),
                formatUsd(result.cost.total / loaded.turns, locale)
              )}
            </p>
          )}
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            {result.cost.unpriced.length > 0 && (
              <p className="text-amber-700 dark:text-amber-400">
                {copy.unpriced(
                  result.cost.unpriced.map((m) => name(m.model)).join(copy.sep)
                )}
              </p>
            )}
            {!result.split.complete && result.split.restModel && (
              <p>{copy.assumed(name(result.split.restModel))}</p>
            )}
            <p>
              {copy.note(
                copy.ttl[result.cost.ttl],
                `LiteLLM ${
                  (prices?.updatedAt ?? "").slice(0, 10) ||
                  prices?.revision.slice(0, 7)
                }`
              )}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
