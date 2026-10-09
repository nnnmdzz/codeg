"use client"

// mobile fork：Token 用量頁的「費用」區塊（美元，API 牌價等值）。不送上游。
//
// 頁面每拿到一份新報表，這裡就依報表裡的每個模型各查一份「只看這個模型」的
// 子報表，再換算成費用（見 @/lib/fork/pricing/token-usage-cost）。與頁面的耦合
// 只有頁面傳進來的報表與篩選條件；圖表與清單是這裡自己的，數字格式是美元。
//
// 清單的每一列可以點開：費用組成、交叉拆分（模型 → 各 agent；agent、資料夾
// → 各模型）、平均每個會話與每回合的費用。趨勢圖依模型堆疊，點選（或游標
// 移到）某個時段，下方列出那個時段各模型的費用。「會話」分組是估算值。
import { useEffect, useId, useRef, useState, type PointerEvent } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  CircleDollarSign,
  Loader2,
} from "lucide-react"
import { CostComposition } from "@/components/fork/cost-composition"
import { ACCENT, INK_FAINT } from "@/components/token-usage/charts"
import { SegmentedFilter } from "@/components/token-usage/token-usage-filters"
import { BrowserLink } from "@/components/ui/browser-link"
import { getFolderConversation, tokenUsageReport } from "@/lib/api"
import { getAgentLabel } from "@/lib/custom-agents"
import { formatUsd } from "@/lib/fork/pricing/format"
import {
  loadPriceTable,
  resolveModelPrice,
  type PriceTable,
} from "@/lib/fork/pricing/pricing"
import {
  computeTokenUsageCost,
  type CostPoint,
  type CostRow,
  type CostShare,
  type SessionCost,
  type TokenUsageCost,
} from "@/lib/fork/pricing/token-usage-cost"
import { refineSessionCost } from "@/lib/fork/pricing/session-refine"
import { formatTokenCount } from "@/lib/token-format"
import type {
  AgentType,
  TokenUsageFilter,
  TokenUsageReport,
  TurnUsage,
} from "@/lib/types"
import { cn } from "@/lib/utils"

// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-TW": {
    title: "費用",
    dims: { model: "模型", agent: "Agent", folder: "資料夾", session: "會話" },
    dimLabel: "費用分組",
    peak: "最高",
    trendLabel: "各時段費用",
    empty: "這段期間沒有可計價的用量",
    other: (n: number) => `其他 ${n} 項`,
    otherModels: "其他",
    tokens: "tokens",
    vsPrevious: "與前一個同長度區間相比",
    deltaNew: "新",
    splitBy: { model: "Agent", agent: "模型", folder: "模型" },
    perSession: (_n: number, count: string, v: string) =>
      `${count} 個會話，平均每個 ${v}`,
    perTurn: (_n: number, count: string, v: string) =>
      `${count} 回合，平均每回合 ${v}`,
    sessionsNote: "標 ≈ 的會話依 token 比例估算。",
    prices: (date: string) => `單價：LiteLLM ${date}`,
    unpriced: (share: string, list: string) =>
      `未計價：${list}（佔 ${share} token）`,
    approximate: "部分模型的細項沒取得，這些模型的費用是粗估。",
    truncated: "資料超過上限，只計入最近的部分。",
    failed: "費用計算失敗：",
    loading: "計算費用中…",
    sep: "、",
    colon: "：",
  },
  "zh-CN": {
    title: "费用",
    dims: { model: "模型", agent: "Agent", folder: "文件夹", session: "会话" },
    dimLabel: "费用分组",
    peak: "最高",
    trendLabel: "各时段费用",
    empty: "这段期间没有可计价的用量",
    other: (n: number) => `其他 ${n} 项`,
    otherModels: "其他",
    tokens: "tokens",
    vsPrevious: "与前一个同长度区间相比",
    deltaNew: "新",
    splitBy: { model: "Agent", agent: "模型", folder: "模型" },
    perSession: (_n: number, count: string, v: string) =>
      `${count} 个会话，平均每个 ${v}`,
    perTurn: (_n: number, count: string, v: string) =>
      `${count} 轮，平均每轮 ${v}`,
    sessionsNote: "标 ≈ 的会话按 token 比例估算。",
    prices: (date: string) => `单价：LiteLLM ${date}`,
    unpriced: (share: string, list: string) =>
      `未计价：${list}（占 ${share} token）`,
    approximate: "部分模型的细项没取得，这些模型的费用是粗估。",
    truncated: "数据超过上限，只计入最近的部分。",
    failed: "费用计算失败：",
    loading: "计算费用中…",
    sep: "、",
    colon: "：",
  },
  en: {
    title: "Cost",
    dims: {
      model: "Model",
      agent: "Agent",
      folder: "Folder",
      session: "Session",
    },
    dimLabel: "Cost breakdown",
    peak: "Peak",
    trendLabel: "Cost per period",
    empty: "No priced usage in this range",
    other: (n: number) => `${n} more`,
    otherModels: "Other",
    tokens: "tokens",
    vsPrevious: "vs the previous period of the same length",
    deltaNew: "new",
    splitBy: { model: "Agents", agent: "Models", folder: "Models" },
    perSession: (n: number, count: string, v: string) =>
      `${count} ${n === 1 ? "session" : "sessions"}, ${v} each on average`,
    perTurn: (n: number, count: string, v: string) =>
      `${count} ${n === 1 ? "turn" : "turns"}, ${v} per turn`,
    sessionsNote: "≈ marks sessions estimated by token share.",
    prices: (date: string) => `Rates: LiteLLM ${date}`,
    unpriced: (share: string, list: string) =>
      `Not priced: ${list} (${share} of tokens)`,
    approximate: "Some model details didn't load; those costs are rough.",
    truncated: "Data hit its cap; only the latest part is counted.",
    failed: "Couldn't compute costs: ",
    loading: "Computing costs…",
    sep: ", ",
    colon: ": ",
  },
} as const

type Copy = (typeof COPY)[keyof typeof COPY]
type Dim = "model" | "agent" | "folder" | "session"

/** 頁面目前的篩選條件；模型篩選由這裡逐一帶入，比較區間跟主報表一致。 */
export type CostFilter = Omit<TokenUsageFilter, "models" | "comparePrevious">

const SLICE_CONCURRENCY = 3
const LIST_LIMIT = 8
/** 趨勢圖分色的模型數，其餘合併成「其他」 */
const TREND_SERIES = 3
/** 依序給費用最高的幾個模型：強調色，再往卡片底色淡下去 */
const SERIES_COLORS = [ACCENT, "var(--tu-seq-5)", "var(--tu-seq-3)"]
const OTHER_KEY = "__other__"

function useCopy(): Copy {
  const locale = useLocale()
  return locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
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

/**
 * 子報表快取：同樣的篩選條件、而主報表的數字沒變（資料沒更新），子報表也
 * 不會變。切換篩選再切回來、頁面因事件重新整理而資料沒變時，都不必重查。
 * 資料一變，主報表的總數跟著變，key 也就不同。
 */
const sliceCache = new Map<string, TokenUsageReport>()
const SLICE_CACHE_LIMIT = 200

function reportFingerprint(report: TokenUsageReport): string {
  return JSON.stringify([
    report.totals,
    report.previous_totals,
    report.last_activity_at,
    report.range_start,
    report.range_end,
    report.truncated,
  ])
}

async function fetchSlice(
  filter: TokenUsageFilter,
  fingerprint: string
): Promise<TokenUsageReport> {
  const key = `${fingerprint}|${JSON.stringify(filter)}`
  const hit = sliceCache.get(key)
  if (hit) return hit
  const slice = await tokenUsageReport(filter)
  sliceCache.set(key, slice)
  if (sliceCache.size > SLICE_CACHE_LIMIT) {
    const oldest = sliceCache.keys().next().value
    if (oldest !== undefined) sliceCache.delete(oldest)
  }
  return slice
}

/** 測試用：清掉子報表快取 */
export function resetCostSliceCache() {
  sliceCache.clear()
}

/**
 * 會話的總用量（session_stats），「會話」分組用來把估算換成實際數字。以
 * fromIndex 跳過所有回合，回應只有統計，很小；伺服器仍要解析整份紀錄，所以
 * 只在打開這個分組時讀前幾名，同時最多兩個，結果在這次頁面期間快取。key
 * 含最後活動時間，會話有新用量就重讀。讀不到記為 null，維持估算。
 */
const sessionTotals = new Map<string, TurnUsage | null>()
const SESSION_TOTALS_LIMIT = 100
const SESSION_TOTALS_CONCURRENCY = 2
const sessionKey = (s: SessionCost) => `${s.id}:${s.lastActivityAt}`

function useSessionTotals(sessions: SessionCost[]) {
  const [, setVersion] = useState(0)
  const keys = sessions.map(sessionKey).join(",")
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  })
  useEffect(() => {
    const missing = sessionsRef.current.filter(
      (s) => !sessionTotals.has(sessionKey(s))
    )
    if (missing.length === 0) return
    let cancelled = false
    void mapLimit(missing, SESSION_TOTALS_CONCURRENCY, async (s) => {
      let total: TurnUsage | null = null
      try {
        const detail = await getFolderConversation(s.id, {
          fromIndex: Number.MAX_SAFE_INTEGER,
        })
        total = detail.session_stats?.total_usage ?? null
      } catch {
        total = null
      }
      sessionTotals.set(sessionKey(s), total)
      if (sessionTotals.size > SESSION_TOTALS_LIMIT) {
        const oldest = sessionTotals.keys().next().value
        if (oldest !== undefined) sessionTotals.delete(oldest)
      }
      if (!cancelled) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
  }, [keys])
  return (s: SessionCost) => sessionTotals.get(sessionKey(s))
}

/** 測試用：清掉會話總用量的快取 */
export function resetSessionTotalsCache() {
  sessionTotals.clear()
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
        const fingerprint = reportFingerprint(report)
        const entries = await mapLimit(priced, SLICE_CONCURRENCY, (model) =>
          fetchSlice(
            { ...base, models: [model], comparePrevious: compare },
            fingerprint
          )
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

interface Series {
  key: string
  color: string
}

/** 趨勢圖的分色：費用最高的幾個模型各一色，其餘合併 */
function trendSeries(models: CostRow[]): Series[] {
  const top = models.slice(0, TREND_SERIES).map((row, i) => ({
    key: row.key,
    color: SERIES_COLORS[i],
  }))
  return models.length > TREND_SERIES
    ? [...top, { key: OTHER_KEY, color: INK_FAINT }]
    : top
}

/** 一個時段依分色加總：不在前幾名的模型併進「其他」 */
function stack(point: CostPoint, series: Series[]): CostShare[] {
  const named = new Set(series.map((s) => s.key))
  let other = 0
  const byKey = new Map<string, number>()
  for (const share of point.byModel) {
    if (named.has(share.key)) byKey.set(share.key, share.cost)
    else other += share.cost
  }
  return series.map((s) => ({
    key: s.key,
    cost: s.key === OTHER_KEY ? other : (byKey.get(s.key) ?? 0),
  }))
}

function CostTrend({
  points,
  models,
  modelName,
  locale,
  copy,
}: {
  points: CostPoint[]
  models: CostRow[]
  modelName: (key: string) => string
  locale: string
  copy: Copy
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const max = points.reduce((m, p) => Math.max(m, p.cost), 0)
  if (points.length === 0 || max <= 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {copy.empty}
      </p>
    )
  }
  const series = trendSeries(models)
  const peak = points.reduce(
    (best, p, i) => (p.cost > points[best].cost ? i : best),
    0
  )
  const shown = selected !== null && selected < points.length ? selected : peak
  const n = points.length
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * n)
    setSelected(Math.min(n - 1, Math.max(0, index)))
  }
  const breakdown = stack(points[shown], series).filter((s) => s.cost > 0)
  return (
    <div className="tu-viz">
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {selected === null ? `${copy.peak} · ` : ""}
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
          if (event.pointerType === "mouse") pick(event)
        }}
        // 點一下（觸控或滑鼠）就選定那個時段；手指離開也保留
        onPointerDown={pick}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setSelected(null)
        }}
      >
        {points.map((p, i) => {
          if (p.cost <= 0) return null
          let y = 100
          const total = Math.max(1.5, (p.cost / max) * 100)
          const dim = i !== shown && selected !== null
          return (
            <g key={p.key} opacity={dim ? 0.45 : 1}>
              {stack(p, series).map((s) => {
                if (s.cost <= 0) return null
                const h = (s.cost / p.cost) * total
                y -= h
                return (
                  <rect
                    key={s.key}
                    x={i * 10 + 1.5}
                    y={y}
                    width={7}
                    height={h}
                    fill={series.find((x) => x.key === s.key)?.color ?? ACCENT}
                  />
                )
              })}
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[0.6875rem] text-muted-foreground">
        <span>{bucketLabel(points[0].key)}</span>
        {n > 1 && <span>{bucketLabel(points[n - 1].key)}</span>}
      </div>
      {series.length > 1 && breakdown.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {breakdown.map((s) => (
            <li key={s.key} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: series.find((x) => x.key === s.key)?.color,
                }}
              />
              <span className="truncate">
                {s.key === OTHER_KEY ? copy.otherModels : modelName(s.key)}
              </span>
              <span className="font-mono tabular-nums text-foreground">
                {formatUsd(s.cost, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 前幾項之後併成「其他」，用在交叉拆分那一行 */
function topShares(items: CostShare[], limit: number) {
  const shown = items.slice(0, limit)
  const rest = items.slice(limit).reduce((sum, s) => sum + s.cost, 0)
  return { shown, rest }
}

function RowDetail({
  id,
  row,
  dim,
  splitName,
  locale,
  copy,
}: {
  id: string
  row: CostRow
  dim: Exclude<Dim, "session">
  splitName: (key: string) => string
  locale: string
  copy: Copy
}) {
  const { shown, rest } = topShares(row.split, 3)
  const count = (n: number) => n.toLocaleString(locale)
  const units = [
    row.conversations > 0 &&
      copy.perSession(
        row.conversations,
        count(row.conversations),
        formatUsd(row.cost / row.conversations, locale)
      ),
    row.turns > 0 &&
      copy.perTurn(
        row.turns,
        count(row.turns),
        formatUsd(row.cost / row.turns, locale)
      ),
  ].filter(Boolean)
  return (
    <div
      id={id}
      className="mt-2 mb-1 space-y-2.5 rounded-lg bg-muted/40 px-3 py-2.5"
    >
      <CostComposition parts={row.composition} compact />
      {shown.length > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {copy.splitBy[dim]}
          {copy.colon}
          {shown.map((s, i) => (
            <span key={s.key}>
              {i > 0 && " · "}
              {splitName(s.key)}{" "}
              <span className="font-mono tabular-nums text-foreground">
                {formatUsd(s.cost, locale)}
              </span>
            </span>
          ))}
          {rest > 0 && (
            <>
              {" · "}
              {copy.otherModels}{" "}
              <span className="font-mono tabular-nums text-foreground">
                {formatUsd(rest, locale)}
              </span>
            </>
          )}
        </p>
      )}
      {units.length > 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {units.join(copy.sep)}
        </p>
      )}
    </div>
  )
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(pct, pct > 0 ? 1.5 : 0)}%`,
          backgroundColor: ACCENT,
        }}
      />
    </div>
  )
}

function CostList({
  rows,
  dim,
  total,
  splitName,
  locale,
  copy,
}: {
  rows: (CostRow & { display: string })[]
  dim: Exclude<Dim, "session">
  total: number
  splitName: (key: string) => string
  locale: string
  copy: Copy
}) {
  const [open, setOpen] = useState<string | null>(null)
  const baseId = useId()
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {copy.empty}
      </p>
    )
  }
  const shown = rows.slice(0, LIST_LIMIT)
  const rest = rows.slice(LIST_LIMIT)
  const max = shown[0]?.cost ?? 0
  const restCost = rest.reduce((sum, r) => sum + r.cost, 0)
  const share = (cost: number) =>
    total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : ""
  return (
    // 與頁面的 RankedBars 同一個樣子，只是金額換成美元；每一列可以點開
    <ul className="space-y-1.5">
      {shown.map((row) => {
        const expanded = open === row.key
        const detailId = `${baseId}-${row.key}`
        return (
          <li key={row.key}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={expanded ? detailId : undefined}
              onClick={() => setOpen(expanded ? null : row.key)}
              className="w-full rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
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
                  {share(row.cost)}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 self-center text-muted-foreground transition-transform",
                    expanded && "rotate-180"
                  )}
                />
              </div>
              <Bar pct={max > 0 ? Math.min(100, (row.cost / max) * 100) : 0} />
            </button>
            {expanded && (
              <RowDetail
                id={detailId}
                row={row}
                dim={dim}
                splitName={splitName}
                locale={locale}
                copy={copy}
              />
            )}
          </li>
        )
      })}
      {rest.length > 0 && (
        <li className="px-1 py-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground">
              {copy.other(rest.length)}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums">
              {formatUsd(restCost, locale)}
            </span>
            <span className="w-10 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
              {share(restCost)}
            </span>
            <span aria-hidden="true" className="size-3.5 shrink-0" />
          </div>
          <Bar pct={max > 0 ? Math.min(100, (restCost / max) * 100) : 0} />
        </li>
      )}
    </ul>
  )
}

function SessionList({
  sessions,
  total,
  prices,
  untitled,
  locale,
  copy,
}: {
  sessions: SessionCost[]
  total: number
  prices: PriceTable | null
  untitled: string
  locale: string
  copy: Copy
}) {
  const candidates = sessions.slice(0, LIST_LIMIT)
  // 只有這個清單顯示時（打開「會話」分組）才讀
  const totalOf = useSessionTotals(candidates)
  if (sessions.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {copy.empty}
      </p>
    )
  }
  const shown = candidates
    .map((s) => {
      const usage = totalOf(s)
      const refined =
        usage && prices ? refineSessionCost(s, usage, prices) : null
      return refined
        ? { ...s, cost: refined.cost, exact: refined.exact }
        : { ...s, exact: false }
    })
    .sort((a, b) => b.cost - a.cost)
  const max = shown[0]?.cost ?? 0
  return (
    <div>
      <ul className="space-y-1.5">
        {shown.map((s) => (
          <li key={s.id} className="px-1 py-1">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                {s.title || untitled}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {formatTokenCount(s.tokens)} {copy.tokens}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                {!s.exact && "≈ "}
                {formatUsd(s.cost, locale)}
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                {total > 0 ? `${((s.cost / total) * 100).toFixed(1)}%` : ""}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
              {[getAgentLabel(s.agent as AgentType), s.folder]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <Bar pct={max > 0 ? Math.min(100, (s.cost / max) * 100) : 0} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {copy.sessionsNote}
      </p>
    </div>
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

  const modelName = (key: string) =>
    key === "__unknown__" ? t("unknownModel") : key
  const agentName = (key: string) => getAgentLabel(key as AgentType)
  const label = (key: string, fallback: string) => {
    if (dim === "agent") return agentName(key)
    if (dim === "model") return modelName(key)
    return fallback
  }
  const rows =
    cost && dim !== "session"
      ? (dim === "model"
          ? cost.byModel
          : dim === "agent"
            ? cost.byAgent
            : cost.byFolder
        ).map((row) => ({ ...row, display: label(row.key, row.label) }))
      : []

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
        </div>
        <SegmentedFilter
          ariaLabel={copy.dimLabel}
          value={dim}
          onChange={setDim}
          options={(["model", "agent", "folder", "session"] as const).map(
            (d) => ({
              value: d,
              label: copy.dims[d],
            })
          )}
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
              <CostComposition parts={cost.composition} className="mt-4" />
              <div className="mt-5">
                <CostTrend
                  points={cost.series}
                  models={cost.byModel}
                  modelName={modelName}
                  locale={locale}
                  copy={copy}
                />
              </div>
            </div>
            {dim === "session" ? (
              <SessionList
                sessions={cost.sessions}
                total={cost.total}
                prices={prices}
                untitled={t("untitledSession")}
                locale={locale}
                copy={copy}
              />
            ) : (
              <CostList
                // 換分組時收起展開的那一列
                key={dim}
                rows={rows}
                dim={dim}
                total={cost.total}
                splitName={dim === "model" ? agentName : modelName}
                locale={locale}
                copy={copy}
              />
            )}
          </div>

          <div className="mt-4 space-y-1 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
            {cost.unpriced.models.length > 0 && (
              <p className="text-amber-700 dark:text-amber-400">
                {copy.unpriced(
                  `${(cost.unpriced.share * 100).toFixed(1)}%`,
                  cost.unpriced.models
                    .map((m) => modelName(m.key))
                    .join(copy.sep)
                )}
              </p>
            )}
            {cost.approximate && <p>{copy.approximate}</p>}
            {cost.truncated && <p>{copy.truncated}</p>}
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
