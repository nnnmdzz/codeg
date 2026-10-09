"use client"

// mobile fork：Token 用量頁的「費用」區塊（美元，API 牌價等值）。不送上游。
//
// 頁面每拿到一份新報表，這裡就依報表裡的每個模型各查一份「只看這個模型」的
// 子報表，再換算成費用（見 @/lib/fork/pricing/token-usage-cost）。與頁面的耦合
// 只有頁面傳進來的報表與篩選條件；圖表與清單是這裡自己的，數字格式是美元。
import { useEffect, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleDollarSign,
  Loader2,
} from "lucide-react"
import { ACCENT } from "@/components/token-usage/charts"
import { SegmentedFilter } from "@/components/token-usage/token-usage-filters"
import { BrowserLink } from "@/components/ui/browser-link"
import { tokenUsageReport } from "@/lib/api"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  loadPriceTable,
  resolveModelPrice,
  type PriceTable,
} from "@/lib/fork/pricing/pricing"
import {
  computeTokenUsageCost,
  type CostPoint,
  type CostRow,
  type TokenUsageCost,
} from "@/lib/fork/pricing/token-usage-cost"
import { formatTokenCount } from "@/lib/token-format"
import type { AgentType, TokenUsageFilter, TokenUsageReport } from "@/lib/types"
import { cn } from "@/lib/utils"

// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-TW": {
    title: "費用（API 牌價等值）",
    hint: "以各模型的官方 API 單價換算；訂閱方案不按 token 計費，走代理的價格也不同，這不是實際帳單。",
    dims: { model: "模型", agent: "Agent", folder: "資料夾" },
    dimLabel: "費用分組",
    peak: "最高",
    trendLabel: "各區段費用",
    empty: "這段期間沒有可計價的用量",
    other: (n: number) => `其他 ${n} 項`,
    tokens: "tokens",
    vsPrevious: "與前一個同長度區間相比",
    deltaNew: "新",
    assumptions:
      "快取寫入：Claude Code 以 1 小時計，其他 agent 以 5 分鐘計。長上下文加價、快速模式、批次折扣未計入；過去的用量以目前單價回算。",
    prices: (date: string) => `單價：LiteLLM（${date}）`,
    unpriced: (n: number, share: string, list: string) =>
      `${n} 個模型查不到單價、未計入費用（佔 ${share} token）：${list}`,
    approximate: "有模型的細項沒有取得，該模型的費用以 5 分鐘快取價粗估。",
    truncated: "資料量超過上限，費用只涵蓋最近的一部分。",
    failed: "費用計算失敗：",
    loading: "計算費用中…",
    sep: "、",
  },
  "zh-CN": {
    title: "费用（API 牌价等值）",
    hint: "以各模型的官方 API 单价换算；订阅方案不按 token 计费，走代理的价格也不同，这不是实际账单。",
    dims: { model: "模型", agent: "Agent", folder: "文件夹" },
    dimLabel: "费用分组",
    peak: "最高",
    trendLabel: "各区段费用",
    empty: "这段期间没有可计价的用量",
    other: (n: number) => `其他 ${n} 项`,
    tokens: "tokens",
    vsPrevious: "与前一个同长度区间相比",
    deltaNew: "新",
    assumptions:
      "缓存写入：Claude Code 以 1 小时计，其他 agent 以 5 分钟计。长上下文加价、快速模式、批量折扣未计入；过去的用量以当前单价回算。",
    prices: (date: string) => `单价：LiteLLM（${date}）`,
    unpriced: (n: number, share: string, list: string) =>
      `${n} 个模型查不到单价、未计入费用（占 ${share} token）：${list}`,
    approximate: "有模型的细项没有取得，该模型的费用以 5 分钟缓存价粗估。",
    truncated: "数据量超过上限，费用只涵盖最近的一部分。",
    failed: "费用计算失败：",
    loading: "计算费用中…",
    sep: "、",
  },
  en: {
    title: "Cost (API list-price equivalent)",
    hint: "Token usage priced at each model's official API rates. Subscriptions aren't billed per token and proxies charge differently — this is not your bill.",
    dims: { model: "Model", agent: "Agent", folder: "Folder" },
    dimLabel: "Cost breakdown",
    peak: "Peak",
    trendLabel: "Cost per period",
    empty: "No priced usage in this range",
    other: (n: number) => `${n} more`,
    tokens: "tokens",
    vsPrevious: "vs the previous period of the same length",
    deltaNew: "new",
    assumptions:
      "Cache writes: 1-hour rate for Claude Code, 5-minute rate for other agents. Long-context surcharges, fast mode and batch discounts are not applied; past usage is priced at today's rates.",
    prices: (date: string) => `Rates: LiteLLM (${date})`,
    unpriced: (n: number, share: string, list: string) =>
      `${n} model(s) have no known rate and are left out (${share} of tokens): ${list}`,
    approximate:
      "Some per-model details didn't load; those models are estimated at the 5-minute cache rate.",
    truncated:
      "The data hit its row cap; costs cover only the most recent slice.",
    failed: "Couldn't compute costs: ",
    loading: "Computing costs…",
    sep: ", ",
  },
} as const

type Copy = (typeof COPY)[keyof typeof COPY]
type Dim = "model" | "agent" | "folder"

/** 頁面目前的篩選條件；模型篩選由這裡逐一帶入，比較區間跟主報表一致。 */
export type CostFilter = Omit<TokenUsageFilter, "models" | "comparePrevious">

const SLICE_CONCURRENCY = 3
const LIST_LIMIT = 8

function useCopy(): Copy {
  const locale = useLocale()
  return locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
}

function formatUsd(value: number, locale: string): string {
  const digits = value > 0 && value < 0.01 ? 4 : value < 1 ? 3 : 2
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/** `YYYY-MM-DD` → `MM/DD`，`YYYY-MM` → `YYYY/MM` */
function bucketLabel(key: string): string {
  const parts = key.split("-")
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : parts.join("/")
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return out
}

interface CostState {
  report: TokenUsageReport | null
  cost: TokenUsageCost | null
  prices: PriceTable | null
  error: string | null
}

function useTokenUsageCost(report: TokenUsageReport, filter: CostFilter) {
  // 篩選條件每次 render 都是新物件；以報表為準重算，篩選條件讀最新值即可
  // （頁面先改篩選、再拿到對應的報表）。
  const filterRef = useRef(filter)
  useEffect(() => {
    filterRef.current = filter
  })
  const [state, setState] = useState<CostState>({
    report: null,
    cost: null,
    prices: null,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    const base = filterRef.current
    const compare = report.previous_totals !== null
    loadPriceTable()
      .then(async (prices) => {
        // 查不到單價的模型不用查：它的細項也算不出費用
        const priced = report.by_model
          .map((m) => m.key)
          .filter((key) => resolveModelPrice(key, prices) !== null)
        const entries = await mapLimit(priced, SLICE_CONCURRENCY, (model) =>
          tokenUsageReport({
            ...base,
            models: [model],
            comparePrevious: compare,
          })
            .then((slice) => [model, slice] as const)
            // 單一模型失敗不拖垮全部：該模型改以粗估（approximate）
            .catch(() => null)
        )
        if (cancelled) return
        const slices = new Map(
          entries.filter(
            (e): e is readonly [string, TokenUsageReport] => e !== null
          )
        )
        setState({
          report,
          cost: computeTokenUsageCost(report, slices, prices),
          prices,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState((s) => ({
          ...s,
          report,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    return () => {
      cancelled = true
    }
  }, [report])

  return { ...state, loading: state.report !== report }
}

function DeltaChip({
  total,
  previous,
  copy,
}: {
  total: number
  previous: number | null
  copy: Copy
}) {
  if (previous === null || (previous === 0 && total === 0)) return null
  const ratio = previous > 0 ? (total - previous) / previous : null
  if (ratio !== null && Math.abs(ratio) < 0.005) return null
  const Icon = ratio === null || ratio > 0 ? ArrowUpRight : ArrowDownRight
  return (
    // 與頁面的 DeltaBadge 同一個樣子：費用增減不分好壞，不上狀態色
    <span
      title={copy.vsPrevious}
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="font-mono tabular-nums">
        {ratio === null
          ? copy.deltaNew
          : `${ratio > 0 ? "+" : ""}${Math.round(ratio * 100)}%`}
      </span>
    </span>
  )
}

function CostTrend({
  points,
  locale,
  copy,
}: {
  points: CostPoint[]
  locale: string
  copy: Copy
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = points.reduce((m, p) => Math.max(m, p.cost), 0)
  if (points.length === 0 || max <= 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {copy.empty}
      </p>
    )
  }
  const peak = points.reduce(
    (best, p, i) => (p.cost > points[best].cost ? i : best),
    0
  )
  const shown = hover ?? peak
  const n = points.length
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {hover === null ? `${copy.peak} · ` : ""}
          {bucketLabel(points[shown].key)}
        </span>
        <span className="font-mono tabular-nums text-foreground">
          {formatUsd(points[shown].cost, locale)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${n * 10} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={copy.trendLabel}
        className="mt-2 h-28 w-full touch-none"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const index = Math.floor(
            ((event.clientX - rect.left) / rect.width) * n
          )
          setHover(Math.min(n - 1, Math.max(0, index)))
        }}
        onPointerLeave={() => setHover(null)}
      >
        {points.map((p, i) => {
          if (p.cost <= 0) return null
          const height = Math.max(1.5, (p.cost / max) * 100)
          return (
            <rect
              key={p.key}
              x={i * 10 + 1.5}
              y={100 - height}
              width={7}
              height={height}
              fill={ACCENT}
              opacity={hover === null || hover === i ? 1 : 0.45}
            />
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[0.6875rem] text-muted-foreground">
        <span>{bucketLabel(points[0].key)}</span>
        {n > 1 && <span>{bucketLabel(points[n - 1].key)}</span>}
      </div>
    </div>
  )
}

function CostList({
  rows,
  total,
  locale,
  copy,
}: {
  rows: (CostRow & { display: string })[]
  total: number
  locale: string
  copy: Copy
}) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {copy.empty}
      </p>
    )
  }
  const shown = rows.slice(0, LIST_LIMIT)
  const rest = rows.slice(LIST_LIMIT)
  const restCost = rest.reduce((sum, r) => sum + r.cost, 0)
  const max = shown[0]?.cost ?? 0
  const items = rest.length
    ? [
        ...shown,
        {
          key: "__other__",
          display: copy.other(rest.length),
          label: "",
          cost: restCost,
          tokens: rest.reduce((sum, r) => sum + r.tokens, 0),
        },
      ]
    : shown
  return (
    // 與頁面的 RankedBars 同一個樣子，只是金額換成美元
    <ul className="space-y-2.5">
      {items.map((row) => {
        const pct = max > 0 ? Math.min(100, (row.cost / max) * 100) : 0
        return (
          <li key={row.key} className="px-1 py-0.5">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                {row.display}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {formatTokenCount(row.tokens)} {copy.tokens}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                {formatUsd(row.cost, locale)}
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                {total > 0 ? `${((row.cost / total) * 100).toFixed(1)}%` : ""}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(pct, row.cost > 0 ? 1.5 : 0)}%`,
                  backgroundColor: ACCENT,
                }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function TokenUsageCostSection({
  report,
  filter,
}: {
  report: TokenUsageReport
  filter: CostFilter
}) {
  const copy = useCopy()
  const locale = useLocale()
  const t = useTranslations("TokenUsage")
  const [dim, setDim] = useState<Dim>("model")
  const { cost, prices, error, loading } = useTokenUsageCost(report, filter)

  const label = (key: string, fallback: string) => {
    if (dim === "agent") return getAgentLabel(key as AgentType)
    if (dim === "model" && key === "__unknown__") return t("unknownModel")
    return fallback
  }
  const rows = cost
    ? (dim === "model"
        ? cost.byModel
        : dim === "agent"
          ? cost.byAgent
          : cost.byFolder
      ).map((row) => ({ ...row, display: label(row.key, row.label) }))
    : []
  const modelName = (key: string) =>
    key === "__unknown__" ? t("unknownModel") : key

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <header className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
            <CircleDollarSign
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {copy.title}
            {loading && cost && (
              <Loader2
                className="size-3.5 animate-spin text-muted-foreground"
                aria-label={copy.loading}
              />
            )}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {copy.hint}
          </p>
        </div>
        <SegmentedFilter
          ariaLabel={copy.dimLabel}
          value={dim}
          onChange={setDim}
          options={(["model", "agent", "folder"] as const).map((d) => ({
            value: d,
            label: copy.dims[d],
          }))}
        />
      </header>

      {error && !cost ? (
        <p className="py-6 text-center text-sm text-destructive">
          {copy.failed}
          {error}
        </p>
      ) : !cost ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {copy.loading}
        </div>
      ) : (
        <div className={cn("transition-opacity", loading && "opacity-60")}>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-4xl font-semibold leading-none tracking-tight">
                  {formatUsd(cost.total, locale)}
                </span>
                <DeltaChip
                  total={cost.total}
                  previous={cost.previousTotal}
                  copy={copy}
                />
              </div>
              <div className="mt-5">
                <CostTrend points={cost.series} locale={locale} copy={copy} />
              </div>
            </div>
            <CostList
              rows={rows}
              total={cost.total}
              locale={locale}
              copy={copy}
            />
          </div>

          <div className="mt-4 space-y-1 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
            {cost.unpriced.models.length > 0 && (
              <p className="text-amber-700 dark:text-amber-400">
                {copy.unpriced(
                  cost.unpriced.models.length,
                  `${(cost.unpriced.share * 100).toFixed(1)}%`,
                  cost.unpriced.models
                    .map((m) => modelName(m.key))
                    .join(copy.sep)
                )}
              </p>
            )}
            {cost.approximate && <p>{copy.approximate}</p>}
            {cost.truncated && <p>{copy.truncated}</p>}
            <p>{copy.assumptions}</p>
            {prices && (
              <p>
                <BrowserLink
                  href={prices.source}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  {copy.prices(
                    (prices.updatedAt ?? "").slice(0, 10) ||
                      prices.revision.slice(0, 7)
                  )}
                </BrowserLink>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
