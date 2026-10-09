// mobile fork：單一會話的費用（會話詳情的「費用」區塊）。
//
// 會話的 session_stats 只有四類 token 的總數，不分模型；中途換過模型的會話
// （/model）要逐回合依模型加總才算得準。逐回合的資料只用已經在記憶體裡的
// （開著的會話的時間軸），不為了算費用另外讀整份會話：長會話的紀錄可達數十
// MB。費用一律以 session_stats 的總數為準，跟會話詳情上方顯示的 token 數一致。
import type { MessageTurn, TurnUsage } from "@/lib/types"
import {
  addParts,
  cacheSavings,
  cacheTtlForAgent,
  cacheWriteRate,
  costParts,
  NO_COST,
  resolveModelPrice,
  tokenCost,
  type CacheTtl,
  type CostParts,
  type PriceTable,
  type TokenCounts,
} from "./pricing"

/** 模型名 → 該模型的用量 */
export type ModelUsage = Map<string, TurnUsage>

export const UNKNOWN_MODEL = "__unknown__"

const KINDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const

const ZERO: TurnUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

export const tokensOf = (usage: TurnUsage) =>
  KINDS.reduce((sum, kind) => sum + usage[kind], 0)

/** 已載入（在記憶體裡）的回合依模型的用量。 */
export interface LoadedUsage {
  /** 沒記錄模型的回合在 UNKNOWN_MODEL */
  perModel: ModelUsage
  /** 已載入回合中最早記錄的模型 */
  firstModel: string | null
  /** 已載入的回合從會話的第一個回合開始（沒有更早、未載入的回合） */
  coversStart: boolean
}

export function loadedUsageOf(
  turns: readonly MessageTurn[],
  coversStart: boolean
): LoadedUsage {
  const perModel: ModelUsage = new Map()
  let firstModel: string | null = null
  for (const turn of turns) {
    if (turn.model && firstModel === null) firstModel = turn.model
    if (!turn.usage) continue
    const model = turn.model || UNKNOWN_MODEL
    const sum = { ...(perModel.get(model) ?? ZERO) }
    for (const kind of KINDS) sum[kind] += turn.usage[kind]
    perModel.set(model, sum)
  }
  return { perModel, firstModel, coversStart }
}

export interface SessionUsageSplit {
  /** 模型 → 用量，總和等於會話的總數 */
  perModel: ModelUsage
  /** 已載入回合以外的用量算到了哪個模型；沒有這部分時為 null */
  restModel: string | null
  /** 拆分是確定的；否則有一部分是推定的（見 splitSessionUsage） */
  complete: boolean
}

/**
 * 以會話的總數為準依模型拆分。已載入回合的用量照實計；總數多出來的部分
 * （未載入的較早回合，或還沒補上用量的最新回合）算到一個模型：已載入的回合
 * 涵蓋開頭時，多出來的只會是最新的回合，算到目前的模型；否則是較早的回合，
 * 算到已載入回合中最早的模型。後者在會話用過不只一個模型時是推定的
 * （complete 為 false）。
 *
 * 已載入回合的某類 token 比總數多時（兩邊更新的時間差），依比例縮到總數。
 * 沒記錄模型的回合算到目前的模型。
 */
export function splitSessionUsage(
  total: TurnUsage,
  loaded: LoadedUsage,
  currentModel: string | null
): SessionUsageSplit {
  const known: ModelUsage = new Map()
  for (const [model, usage] of loaded.perModel) {
    const name = model === UNKNOWN_MODEL && currentModel ? currentModel : model
    const sum = { ...(known.get(name) ?? ZERO) }
    for (const kind of KINDS) sum[kind] += usage[kind]
    known.set(name, sum)
  }
  const restModel =
    (loaded.coversStart ? currentModel : loaded.firstModel) ??
    currentModel ??
    UNKNOWN_MODEL

  const out: ModelUsage = new Map()
  const entry = (model: string) => {
    const usage = out.get(model) ?? { ...ZERO }
    out.set(model, usage)
    return usage
  }
  let rest = false
  for (const kind of KINDS) {
    const sum = [...known.values()].reduce((acc, u) => acc + u[kind], 0)
    if (sum > total[kind]) {
      for (const [model, usage] of known) {
        entry(model)[kind] = Math.round((usage[kind] / sum) * total[kind])
      }
      continue
    }
    for (const [model, usage] of known) entry(model)[kind] = usage[kind]
    if (total[kind] > sum) {
      entry(restModel)[kind] += total[kind] - sum
      rest = true
    }
  }
  for (const [model, usage] of out) {
    if (tokensOf(usage) === 0) out.delete(model)
  }
  return {
    perModel: out,
    restModel: rest ? restModel : null,
    complete: !rest || loaded.coversStart || out.size <= 1,
  }
}

function counts(usage: TurnUsage): TokenCounts {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_tokens: usage.cache_creation_input_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
  }
}

export interface SessionCost {
  total: number
  byModel: { model: string; cost: number; tokens: number }[]
  composition: CostParts
  cacheSavings: number
  unpriced: { model: string; tokens: number }[]
  /** 快取寫入依哪種有效期限計價（依會話的 agent） */
  ttl: CacheTtl
}

export function computeSessionCost(
  perModel: ModelUsage,
  agentType: string,
  prices: PriceTable
): SessionCost {
  const ttl = cacheTtlForAgent(agentType)
  const byModel: SessionCost["byModel"] = []
  const unpriced: SessionCost["unpriced"] = []
  let composition = NO_COST
  let savings = 0
  for (const [model, usage] of perModel) {
    const tokens = tokensOf(usage)
    if (tokens === 0) continue
    const price = resolveModelPrice(model, prices)
    if (!price) {
      unpriced.push({ model, tokens })
      continue
    }
    const rate = cacheWriteRate(price, ttl)
    byModel.push({ model, cost: tokenCost(counts(usage), price, rate), tokens })
    composition = addParts(composition, costParts(counts(usage), price, rate))
    savings += cacheSavings(counts(usage), price, rate)
  }
  byModel.sort((a, b) => b.cost - a.cost)
  unpriced.sort((a, b) => b.tokens - a.tokens)
  return {
    total: byModel.reduce((sum, m) => sum + m.cost, 0),
    byModel,
    composition,
    cacheSavings: savings,
    unpriced,
    ttl,
  }
}
