// mobile fork：模型單價查詢與 token 計價（Token 用量頁的「費用」區塊）。
//
// 單價來自 ./prices.json（LiteLLM 快照，見 scripts/fork/vendor-prices.mjs），
// 美元／百萬 token。算出來的是 API 牌價等值，不是實際帳單：訂閱方案不按
// token 計費，走代理的價格也不同。

/** [輸入, 輸出, 快取寫入（5 分鐘）, 快取寫入（1 小時）, 快取讀取] */
type PriceRow = [number, number, number | null, number | null, number | null]

export interface PriceTable {
  source: string
  revision: string
  updatedAt: string | null
  models: Record<string, PriceRow>
}

export interface ModelPrice {
  input: number
  output: number
  cacheWrite5m: number | null
  cacheWrite1h: number | null
  cacheRead: number | null
}

export interface TokenCounts {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
}

export type CacheTtl = "5m" | "1h"

let table: Promise<PriceTable> | null = null

/** 單價表只在用到時才載入（獨立的 chunk）。 */
export function loadPriceTable(): Promise<PriceTable> {
  table ??= import("./prices.json")
    .then((mod) => (mod.default ?? mod) as unknown as PriceTable)
    .catch((error: unknown) => {
      table = null
      throw error
    })
  return table
}

/**
 * codeg 記錄的模型名可能帶 `[1m]` 這類後綴、供應商前綴（`anthropic/…`）或
 * 日期（`-20250929`）；價格表的 key 是小寫、沒有前綴。依序嘗試，先對到先用。
 */
export function modelPriceCandidates(model: string): string[] {
  const lower = model.trim().toLowerCase()
  const noSuffix = lower.replace(/\[[^\]]*\]$/, "")
  const noProvider = noSuffix.slice(noSuffix.lastIndexOf("/") + 1)
  const noDate = noProvider.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, "")
  return [...new Set([lower, noSuffix, noProvider, noDate])].filter(Boolean)
}

export function resolveModelPrice(
  model: string,
  prices: PriceTable
): ModelPrice | null {
  for (const key of modelPriceCandidates(model)) {
    const row = prices.models[key]
    if (row) {
      return {
        input: row[0],
        output: row[1],
        cacheWrite5m: row[2],
        cacheWrite1h: row[3],
        cacheRead: row[4],
      }
    }
  }
  return null
}

/**
 * 快取寫入的有效期限決定單價（Anthropic：5 分鐘是輸入的 1.25 倍、1 小時是
 * 2 倍）。codeg 只存寫入總數，所以依 agent 推定：Claude Code 經 ACP 寫入的
 * 快取實測全是 1 小時，其他 agent 以預設的 5 分鐘計。
 */
export function cacheTtlForAgent(agentType: string): CacheTtl {
  return agentType === "claude_code" ? "1h" : "5m"
}

/** 美元／百萬 token。表上缺 1 小時價的 Anthropic 式快取，依官方倍率用輸入的 2 倍。 */
export function cacheWriteRate(price: ModelPrice, ttl: CacheTtl): number {
  if (ttl === "1h") {
    return (
      price.cacheWrite1h ??
      (price.cacheWrite5m !== null ? price.input * 2 : price.input)
    )
  }
  return price.cacheWrite5m ?? price.input
}

/** 美元。`cacheWritePerMillion` 由呼叫端依 agent 決定（見 cacheWriteRate）。 */
export function tokenCost(
  tokens: TokenCounts,
  price: ModelPrice,
  cacheWritePerMillion: number
): number {
  return (
    (tokens.input_tokens * price.input +
      tokens.output_tokens * price.output +
      tokens.cache_creation_tokens * cacheWritePerMillion +
      tokens.cache_read_tokens * (price.cacheRead ?? price.input)) /
    1e6
  )
}

export interface CostParts {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export const NO_COST: CostParts = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
}

/** 四類 token 各花了多少（美元），加起來等於 tokenCost。 */
export function costParts(
  tokens: TokenCounts,
  price: ModelPrice,
  cacheWritePerMillion: number
): CostParts {
  return {
    input: (tokens.input_tokens * price.input) / 1e6,
    output: (tokens.output_tokens * price.output) / 1e6,
    cacheWrite: (tokens.cache_creation_tokens * cacheWritePerMillion) / 1e6,
    cacheRead:
      (tokens.cache_read_tokens * (price.cacheRead ?? price.input)) / 1e6,
  }
}

export function addParts(a: CostParts, b: CostParts): CostParts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  }
}

/**
 * 快取淨省下多少（美元）：快取讀取若以一般輸入計價會多花的，扣掉快取寫入比
 * 一般輸入多付的部分。沒有快取時這些 token 都會是一般輸入。可能為負（寫了
 * 快取卻很少讀到）。
 */
export function cacheSavings(
  tokens: TokenCounts,
  price: ModelPrice,
  cacheWritePerMillion: number
): number {
  const read = price.cacheRead ?? price.input
  return (
    (tokens.cache_read_tokens * (price.input - read) -
      tokens.cache_creation_tokens * (cacheWritePerMillion - price.input)) /
    1e6
  )
}
