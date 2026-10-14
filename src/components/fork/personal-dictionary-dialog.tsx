"use client"

// mobile fork：轉繁體的個人詞庫。不送上游。
//
// 簡體原文 → 寫法，優先於其他所有規則（@/lib/fork/zh-tw/engine）。存在這台
// 裝置（@/lib/fork/zh-tw/settings）。從預覽點選「以後都這樣轉」、或在這裡
// 自己加。
import { useState } from "react"
import { Trash2 } from "lucide-react"
import { useLocale } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  addPersonalRule,
  personalSetting,
  removePersonalRule,
} from "@/lib/fork/zh-tw/settings"

const COPY = {
  "zh-TW": {
    title: "個人詞庫",
    description:
      "轉成繁體時，這些詞一律照你的寫法，優先於內建的規則。只存在這台裝置。",
    source: "原文（簡體）",
    target: "寫成",
    add: "加入",
    remove: (s: string) => `移除「${s}」`,
    empty: "還沒有詞。在繁體預覽點一個詞，選「以後都這樣轉」，或在上面自己加。",
  },
  "zh-CN": {
    title: "个人词库",
    description:
      "转成繁体时，这些词一律照你的写法，优先于内置的规则。只存在这台设备。",
    source: "原文（简体）",
    target: "写成",
    add: "加入",
    remove: (s: string) => `移除“${s}”`,
    empty: "还没有词。在繁体预览点一个词，选“以后都这样转”，或在上面自己加。",
  },
  en: {
    title: "Your dictionary",
    description:
      "When converting to Traditional Chinese, these words always come out your way, ahead of the built-in rules. Stored on this device only.",
    source: "Original (Simplified)",
    target: "Write as",
    add: "Add",
    remove: (s: string) => `Remove “${s}”`,
    empty:
      "No words yet. Tap a word in the Traditional preview and choose “Always convert it this way”, or add one above.",
  },
} as const

export function PersonalDictionaryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const locale = useLocale()
  const copy = locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
  const rules = personalSetting.use()
  const [source, setSource] = useState("")
  const [target, setTarget] = useState("")

  const add = () => {
    const from = source.trim()
    const to = target.trim()
    if (!from || !to) return
    addPersonalRule(from, to)
    setSource("")
    setTarget("")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <Input
            aria-label={copy.source}
            placeholder={copy.source}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
          <Input
            aria-label={copy.target}
            placeholder={copy.target}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <Button type="submit" disabled={!source.trim() || !target.trim()}>
            {copy.add}
          </Button>
        </form>
        {rules.size === 0 ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {copy.empty}
          </p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {[...rules].map(([from, to]) => (
              <li
                key={from}
                className="flex items-center gap-3 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{from}</span>
                  <span aria-hidden className="mx-2 text-muted-foreground">
                    →
                  </span>
                  <span>{to}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={copy.remove(from)}
                  onClick={() => removePersonalRule(from)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
