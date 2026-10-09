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
//
// 會話的費用是估算：報表裡每個會話只有 token 總數（各模型子報表的
// top_conversations），沒有分四類。以該會話的 agent 用這個模型在這段期間的
// 平均單價（費用 ÷ token）乘上它的 token 數。
import type { TokenUsageBreakdownItem, TokenUsageReport } from "@/lib/types"
import {
  addParts,
  cacheTtlForAgent,
  cacheWriteRate,
  costParts,
  NO_COST,
  resolveModelPrice,
  tokenCost,
  type CostParts,
  type PriceTable,
} from "./pricing"

export interface CostShare {
  key: string
  cost: number
}

export interface CostRow {
  key: string
  label: string
  cost: number
  tokens: number
  /** 四類 token 各花了多少，加起來等於 cost */
  composition: CostParts
  /** 交叉拆分，依費用排序：模型列是各 agent，agent 與資料夾列是各模型 */
  split: CostShare[]
  /** 這段期間的會話數與回合數（用來算平均每個會話、每回合的費用） */
  conversations: number
  turns: number
}

export interface CostPoint {
  key: string
  start: string
  cost: number
  /** 這個時段各模型的費用，依費用排序 */
  byModel: CostShare[]
}

export interface SessionCost {
  id: number
  title: string | null
  agent: string
  folder: string | null
  /** 最後活動時間；會話有新用量時跟著變（用來快取會話的總用量） */
  lastActivityAt: string
  tokens: number
  /** 各模型在這段期間的 token 數 */
  models: { key: string; tokens: number }[]
  /** 估算值（見檔頭說明） */
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
  /** 費用估算最高的會話，依費用排序 */
  sessions: SessionCost[]
  /** 四類 token 各花了多少，加起來等於 total */
  composition: CostParts
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

/** 一個分組（模型、agent、資料夾、時段）累積的費用 */
interface Acc {
  cost: number
  composition: CostParts
  split: Map<string, number>
}

class Groups {
  private readonly map = new Map<string, Acc>()

  add(key: string, parts: CostParts, splitKey: string | null) {
    const acc = this.map.get(key) ?? {
      cost: 0,
      composition: NO_COST,
      split: new Map<string, number>(),
    }
    const cost = parts.input + parts.output + parts.cacheWrite + parts.cacheRead
    acc.cost += cost
    acc.composition = addParts(acc.composition, parts)
    if (splitKey !== null) {
      acc.split.set(splitKey, (acc.split.get(splitKey) ?? 0) + cost)
    }
    this.map.set(key, acc)
  }

  get(key: string): Acc | undefined {
    return this.map.get(key)
  }

  rows(items: TokenUsageBreakdownItem[]): CostRow[] {
    const byKey = new Map(items.map((item) => [item.key, item]))
    return [...this.map]
      .filter(([, acc]) => acc.cost > 0)
      .map(([key, acc]) => {
        const item = byKey.get(key)
        return {
          key,
          label: item?.label ?? key,
          cost: acc.cost,
          tokens: item?.total_tokens ?? 0,
          composition: acc.composition,
          split: shares(acc.split),
          conversations: item?.conversation_count ?? 0,
          turns: item?.turn_count ?? 0,
        }
      })
      .sort((a, b) => b.cost - a.cost)
  }
}

function shares(map: Map<string, number>): CostShare[] {
  return [...map]
    .filter(([, cost]) => cost > 0)
    .map(([key, cost]) => ({ key, cost }))
    .sort((a, b) => b.cost - a.cost)
}

const tokensOf = (c: {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
}) =>
  c.input_tokens +
  c.output_tokens +
  c.cache_creation_tokens +
  c.cache_read_tokens

export function computeTokenUsageCost(
  main: TokenUsageReport,
  /** 模型名 → 只篩這個模型的子報表 */
  slices: ReadonlyMap<string, TokenUsageReport>,
  prices: PriceTable
): TokenUsageCost {
  const models = new Groups()
  const agents = new Groups()
  const folders = new Groups()
  const buckets = new Groups()
  const sessions = new Map<number, SessionCost>()
  let previous = main.previous_totals ? 0 : null
  let approximate = false
  let truncated = main.truncated
  const unpriced: { key: string; tokens: number }[] = []
  let composition = NO_COST

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
      const parts = costParts(item, price, cacheWriteRate(price, "5m"))
      models.add(item.key, parts, null)
      composition = addParts(composition, parts)
      continue
    }
    truncated ||= slice.truncated

    let writeCost = 0
    let writeTokens = 0
    // agent → 這個模型在這個 agent 的平均單價（美元／token），估算會話用
    const agentRate = new Map<string, number>()
    let modelCost = 0
    let modelTokens = 0
    for (const agent of slice.by_agent) {
      const rate = cacheWriteRate(price, cacheTtlForAgent(agent.key))
      const parts = costParts(agent, price, rate)
      models.add(item.key, parts, agent.key)
      agents.add(agent.key, parts, item.key)
      composition = addParts(composition, parts)
      const cost = tokenCost(agent, price, rate)
      const tokens = tokensOf(agent)
      if (tokens > 0) agentRate.set(agent.key, cost / tokens)
      modelCost += cost
      modelTokens += tokens
      writeCost += agent.cache_creation_tokens * rate
      writeTokens += agent.cache_creation_tokens
    }

    const blendedWrite =
      writeTokens > 0 ? writeCost / writeTokens : cacheWriteRate(price, "5m")
    for (const folder of slice.by_folder) {
      folders.add(folder.key, costParts(folder, price, blendedWrite), item.key)
    }
    for (const point of slice.series) {
      buckets.add(
        point.bucket_key,
        costParts(point, price, blendedWrite),
        item.key
      )
    }
    if (previous !== null && slice.previous_totals) {
      previous += tokenCost(slice.previous_totals, price, blendedWrite)
    }

    const modelRate = modelTokens > 0 ? modelCost / modelTokens : 0
    for (const conv of slice.top_conversations) {
      const rate = agentRate.get(conv.agent_type) ?? modelRate
      const entry = sessions.get(conv.conversation_id) ?? {
        id: conv.conversation_id,
        title: conv.title,
        agent: conv.agent_type,
        folder: conv.folder_label,
        lastActivityAt: conv.last_activity_at,
        tokens: 0,
        models: [],
        cost: 0,
      }
      if (conv.last_activity_at > entry.lastActivityAt) {
        entry.lastActivityAt = conv.last_activity_at
      }
      entry.tokens += conv.total_tokens
      entry.models.push({ key: item.key, tokens: conv.total_tokens })
      entry.cost += conv.total_tokens * rate
      sessions.set(conv.conversation_id, entry)
    }
  }

  const unpricedTokens = unpriced.reduce((sum, m) => sum + m.tokens, 0)
  const byModel = models.rows(main.by_model)
  return {
    total: byModel.reduce((sum, row) => sum + row.cost, 0),
    previousTotal: previous,
    byModel,
    byAgent: agents.rows(main.by_agent),
    byFolder: folders.rows(main.by_folder),
    series: main.series.map((point) => {
      const acc = buckets.get(point.bucket_key)
      return {
        key: point.bucket_key,
        start: point.start,
        cost: acc?.cost ?? 0,
        byModel: acc ? shares(acc.split) : [],
      }
    }),
    sessions: [...sessions.values()]
      .filter((s) => s.cost > 0)
      .sort((a, b) => b.cost - a.cost),
    composition,
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
