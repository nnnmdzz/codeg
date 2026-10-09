"use client"

// mobile fork：每則回覆的費用（美元，API 牌價等值），以小字顯示在回覆底下
// 那一列。不送上游。
//
// 用的是那則回覆自己的用量與模型，不必連網。回覆底下的 token 明細在提示框
// 裡，提示框在手機上點不開，所以費用直接寫在那一列。快取寫入的單價依 agent
// 而定（見 cacheTtlForAgent），agent 由訊息列表以 ReplyCostAgentProvider 提供，
// 不必經過中間那些依屬性 memo 的元件。合併了不同模型子回合的回覆，用量已經
// 加總在一起，以第一個模型計價並標成估算值。
import { createContext, useContext } from "react"
import { useLocale } from "next-intl"
import { formatUsd } from "@/lib/fork/pricing/format"
import {
  cacheTtlForAgent,
  cacheWriteRate,
  resolveModelPrice,
  tokenCost,
} from "@/lib/fork/pricing/pricing"
import { usePriceTable } from "@/lib/fork/pricing/use-price-table"
import type { TurnUsage } from "@/lib/types"

const AgentTypeContext = createContext<string | null>(null)

/** 訊息列表用它告訴每則回覆是哪個 agent */
export const ReplyCostAgentProvider = AgentTypeContext.Provider

const COPY = {
  "zh-TW": {
    title: "這則回覆的費用（API 牌價等值，不是實際帳單）",
    estimate: "這則回覆用過不只一個模型，以第一個模型估算",
  },
  "zh-CN": {
    title: "这条回复的费用（API 牌价等值，不是实际账单）",
    estimate: "这条回复用过不止一个模型，以第一个模型估算",
  },
  en: {
    title: "Cost of this reply (API list-price equivalent, not your bill)",
    estimate: "This reply used more than one model; estimated at the first",
  },
} as const

export function ReplyCost({
  usage,
  model,
  models,
}: {
  usage?: TurnUsage | null
  model?: string | null
  models?: string[]
}) {
  const locale = useLocale()
  const copy = locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
  const agent = useContext(AgentTypeContext)
  const prices = usePriceTable()
  if (!usage || !model || !prices) return null
  const price = resolveModelPrice(model, prices)
  if (!price) return null
  const cost = tokenCost(
    {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_tokens: usage.cache_creation_input_tokens,
      cache_read_tokens: usage.cache_read_input_tokens,
    },
    price,
    cacheWriteRate(price, cacheTtlForAgent(agent ?? ""))
  )
  if (cost <= 0) return null
  const estimate = (models?.length ?? 0) > 1
  return (
    <span
      className="inline-flex h-6 items-center px-1 font-mono text-[0.6875rem] tabular-nums text-muted-foreground"
      title={estimate ? `${copy.title}\n${copy.estimate}` : copy.title}
    >
      {estimate && "≈ "}
      {formatUsd(cost, locale)}
    </span>
  )
}
