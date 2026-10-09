// mobile fork：把 Token 用量報表換算成費用（美元，API 牌價等值）。
//
// 主報表的 by_model 每個模型都有輸入／輸出／快取寫入／快取讀取四類 token，
// 直接乘單價就是該模型的費用；但日期、agent、資料夾的分組混了不同單價的模型，
// 無法直接計價。所以每個模型另外查一份「只看這個模型」的子報表（API 的
// models 篩選），在子報表裡分別計價再加總。
//
// 快取寫入的單價依 agent 而定（見 cacheTtlForAgent）：模型與 agent 的費用
// 依 agent 精確計算；資料夾與日期沒有 agent 細分，快取寫入改用該模型依 agent
// 比例加權的平均單價，其餘三類照實計算。
import type { TokenUsageBreakdownItem, TokenUsageReport } from "@/lib/types"
import {
  cacheTtlForAgent,
  cacheWriteRate,
  resolveModelPrice,
  tokenCost,
  type PriceTable,
} from "./pricing"

export interface CostRow {
  key: string
  label: string
  cost: number
  tokens: number
}

export interface CostPoint {
  key: string
  start: string
  cost: number
}

export interface TokenUsageCost {
  total: number
  /** 前一個同長度區間的費用；主報表沒有比較區間時為 null */
  previousTotal: number | null
  byModel: CostRow[]
  byAgent: CostRow[]
  byFolder: CostRow[]
  series: CostPoint[]
  /** 查不到單價、未計入費用的模型 */
  unpriced: {
    models: { key: string; tokens: number }[]
    tokens: number
    share: number
  }
  /** 有模型的子報表沒拿到：該模型的費用改以 5 分鐘快取價粗估 */
  approximate: boolean
  truncated: boolean
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value)
}

function rows(
  costs: Map<string, number>,
  items: TokenUsageBreakdownItem[]
): CostRow[] {
  const byKey = new Map(items.map((item) => [item.key, item]))
  return [...costs]
    .filter(([, cost]) => cost > 0)
    .map(([key, cost]) => ({
      key,
      label: byKey.get(key)?.label ?? key,
      cost,
      tokens: byKey.get(key)?.total_tokens ?? 0,
    }))
    .sort((a, b) => b.cost - a.cost)
}

export function computeTokenUsageCost(
  main: TokenUsageReport,
  /** 模型名 → 只篩這個模型的子報表 */
  slices: ReadonlyMap<string, TokenUsageReport>,
  prices: PriceTable
): TokenUsageCost {
  const modelCost = new Map<string, number>()
  const agentCost = new Map<string, number>()
  const folderCost = new Map<string, number>()
  const bucketCost = new Map<string, number>()
  let previous = main.previous_totals ? 0 : null
  let approximate = false
  let truncated = main.truncated
  const unpriced: { key: string; tokens: number }[] = []

  for (const item of main.by_model) {
    const price = resolveModelPrice(item.key, prices)
    if (!price) {
      if (item.total_tokens > 0)
        unpriced.push({ key: item.key, tokens: item.total_tokens })
      continue
    }
    const slice = slices.get(item.key)
    if (!slice) {
      approximate = true
      add(
        modelCost,
        item.key,
        tokenCost(item, price, cacheWriteRate(price, "5m"))
      )
      continue
    }
    truncated ||= slice.truncated

    let cost = 0
    let writeCost = 0
    let writeTokens = 0
    for (const agent of slice.by_agent) {
      const rate = cacheWriteRate(price, cacheTtlForAgent(agent.key))
      const c = tokenCost(agent, price, rate)
      add(agentCost, agent.key, c)
      cost += c
      writeCost += agent.cache_creation_tokens * rate
      writeTokens += agent.cache_creation_tokens
    }
    add(modelCost, item.key, cost)

    const blendedWrite =
      writeTokens > 0 ? writeCost / writeTokens : cacheWriteRate(price, "5m")
    for (const folder of slice.by_folder) {
      add(folderCost, folder.key, tokenCost(folder, price, blendedWrite))
    }
    for (const point of slice.series) {
      add(bucketCost, point.bucket_key, tokenCost(point, price, blendedWrite))
    }
    if (previous !== null && slice.previous_totals) {
      previous += tokenCost(slice.previous_totals, price, blendedWrite)
    }
  }

  const unpricedTokens = unpriced.reduce((sum, m) => sum + m.tokens, 0)
  const byModel = rows(modelCost, main.by_model)
  return {
    total: [...modelCost.values()].reduce((sum, c) => sum + c, 0),
    previousTotal: previous,
    byModel,
    byAgent: rows(agentCost, main.by_agent),
    byFolder: rows(folderCost, main.by_folder),
    series: main.series.map((point) => ({
      key: point.bucket_key,
      start: point.start,
      cost: bucketCost.get(point.bucket_key) ?? 0,
    })),
    unpriced: {
      models: unpriced.sort((a, b) => b.tokens - a.tokens),
      tokens: unpricedTokens,
      share:
        main.totals.total_tokens > 0
          ? unpricedTokens / main.totals.total_tokens
          : 0,
    },
    approximate,
    truncated,
  }
}
