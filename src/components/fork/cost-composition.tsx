"use client"

// mobile fork：費用組成條與圖例（輸入／輸出／快取寫入／快取讀取）。不送上游。
//
// Token 用量頁的費用區塊、展開的模型明細、會話詳情共用。顏色跟頁面的 Token
// 組成一致：快取讀取用強調色，其餘（新算的）用墨色各階。顏色變數只定義在
// `.tu-viz` 底下，所以根元素自己帶上這個 class，放在哪裡都一樣。
import { useLocale } from "next-intl"
import {
  ACCENT,
  INK,
  INK_FAINT,
  INK_SOFT,
} from "@/components/token-usage/charts"
import { formatUsd } from "@/lib/fork/pricing/format"
import type { CostParts } from "@/lib/fork/pricing/pricing"
import { cn } from "@/lib/utils"

const COPY = {
  "zh-TW": {
    label: "費用組成",
    input: "輸入",
    output: "輸出",
    cacheWrite: "快取寫入",
    cacheRead: "快取讀取",
  },
  "zh-CN": {
    label: "费用组成",
    input: "输入",
    output: "输出",
    cacheWrite: "缓存写入",
    cacheRead: "缓存读取",
  },
  en: {
    label: "Cost composition",
    input: "Input",
    output: "Output",
    cacheWrite: "Cache write",
    cacheRead: "Cache read",
  },
} as const

export function CostComposition({
  parts,
  className,
  compact = false,
}: {
  parts: CostParts
  className?: string
  /** 細一點的條，用在展開的明細裡 */
  compact?: boolean
}) {
  const locale = useLocale()
  const copy = locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
  const segments = [
    { key: "cacheRead" as const, value: parts.cacheRead, color: ACCENT },
    { key: "input" as const, value: parts.input, color: INK },
    { key: "cacheWrite" as const, value: parts.cacheWrite, color: INK_SOFT },
    { key: "output" as const, value: parts.output, color: INK_FAINT },
  ]
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
  // flex-grow 的總和小於 1 時填不滿，所以換算成百分比
  const sum = segments.reduce((acc, s) => acc + s.value, 0)
  if (sum <= 0) return null
  return (
    <div className={cn("tu-viz", className)}>
      <div
        role="img"
        aria-label={copy.label}
        className={cn(
          "flex w-full gap-0.5 overflow-hidden rounded-full",
          compact ? "h-1.5" : "h-2"
        )}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            className="min-w-0.5"
            style={{
              flex: `${(s.value / sum) * 100} 1 0%`,
              backgroundColor: s.color,
            }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-[2px]"
              style={{ backgroundColor: s.color }}
            />
            {copy[s.key]}
            <span className="font-mono tabular-nums text-foreground">
              {formatUsd(s.value, locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
