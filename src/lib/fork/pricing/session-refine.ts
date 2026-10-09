// mobile fork：用會話的實際總用量修正「會話」排行的估算。
//
// 報表裡每個會話只有 token 總數（見 token-usage-cost 的 SessionCost）。會話
// 本身的 session_stats 有四類 token 的總數，但涵蓋整個會話、不分模型。所以：
// 這段期間的 token 數（各模型加總）÷ 會話的總 token 數 = 在期間內的比例，
// 四類 token 依這個比例與各模型的 token 比例分攤，再各自計價。
// 會話整段都在期間內、只用一個模型時，結果就是精確的。
import type { TurnUsage } from "@/lib/types"
import {
  cacheTtlForAgent,
  cacheWriteRate,
  resolveModelPrice,
  tokenCost,
  type PriceTable,
} from "./pricing"
import type { SessionCost } from "./token-usage-cost"

export function refineSessionCost(
  session: SessionCost,
  total: TurnUsage,
  prices: PriceTable
): { cost: number; exact: boolean } | null {
  const allTime =
    total.input_tokens +
    total.output_tokens +
    total.cache_creation_input_tokens +
    total.cache_read_input_tokens
  const inRange = session.models.reduce((sum, m) => sum + m.tokens, 0)
  if (allTime <= 0 || inRange <= 0) return null
  const ratio = Math.min(1, inRange / allTime)
  const ttl = cacheTtlForAgent(session.agent)
  let cost = 0
  for (const m of session.models) {
    const price = resolveModelPrice(m.key, prices)
    if (!price) continue
    const f = ratio * (m.tokens / inRange)
    cost += tokenCost(
      {
        input_tokens: total.input_tokens * f,
        output_tokens: total.output_tokens * f,
        cache_creation_tokens: total.cache_creation_input_tokens * f,
        cache_read_tokens: total.cache_read_input_tokens * f,
      },
      price,
      cacheWriteRate(price, ttl)
    )
  }
  const whole = Math.abs(allTime - inRange) <= allTime * 0.001
  return { cost, exact: whole && session.models.length === 1 }
}
