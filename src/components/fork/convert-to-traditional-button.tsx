"use client"

// mobile fork：composer 送出鍵旁的「轉為繁體（台灣用語）」按鈕。不送上游。
//
// 有選取時只轉選取的文字，否則轉整則草稿；引用標籤與反引號裡的程式碼不轉
// （見 @/lib/fork/composer-to-traditional）。轉換器第一次按下時才載入
// （@/lib/fork/s2twp）。轉完的提示帶「復原」，按一次就整筆還原。
//
// 與 composer 的耦合只有 message-input 傳進來的兩樣東西：取得 Tiptap editor
// 的函式，以及 editor 是否已建立。草稿變化自己向 editor 訂閱，不經過
// message-input 的狀態。
import { useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/core"
import { Loader2 } from "lucide-react"
import { useLocale } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  convertComposerText,
  hasHanText,
  undoConversion,
} from "@/lib/fork/composer-to-traditional"
import { loadS2TWP } from "@/lib/fork/s2twp"

// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-TW": {
    label: "轉為繁體（臺灣用語）",
    done: "已轉為繁體",
    undo: "復原",
    nothing: "沒有需要轉換的簡體字",
    failed: "轉換器載入失敗，請稍後再試",
  },
  "zh-CN": {
    label: "转为繁体（台湾用语）",
    done: "已转为繁体",
    undo: "撤销",
    nothing: "没有需要转换的简体字",
    failed: "转换器加载失败，请稍后再试",
  },
  en: {
    label: "Convert to Traditional Chinese (Taiwan)",
    done: "Converted to Traditional Chinese",
    undo: "Undo",
    nothing: "Nothing to convert",
    failed: "Couldn't load the converter. Try again shortly.",
  },
} as const

function useCopy() {
  const locale = useLocale()
  return locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
}

/** 草稿裡有沒有漢字，跟著 editor 更新；editor 若重建（destroy）就重新訂閱。 */
function useDraftHasHan(getEditor: () => Editor | null, ready: boolean) {
  const getEditorRef = useRef(getEditor)
  useEffect(() => {
    getEditorRef.current = getEditor
  }, [getEditor])
  const [hasHan, setHasHan] = useState(false)
  const [binding, setBinding] = useState(0)

  useEffect(() => {
    if (!ready) return
    const editor = getEditorRef.current()
    if (!editor || editor.isDestroyed) {
      // 已經標示 ready、editor 卻還沒出來：稍後再試一次
      const retry = window.setTimeout(() => setBinding((n) => n + 1), 200)
      return () => window.clearTimeout(retry)
    }
    const recompute = () => setHasHan(hasHanText(editor))
    const rebind = () => setBinding((n) => n + 1)
    recompute()
    editor.on("update", recompute)
    editor.on("destroy", rebind)
    return () => {
      editor.off("update", recompute)
      editor.off("destroy", rebind)
    }
  }, [ready, binding])

  return hasHan
}

export function ConvertToTraditionalButton({
  getEditor,
  ready,
  disabled = false,
}: {
  getEditor: () => Editor | null
  ready: boolean
  disabled?: boolean
}) {
  const copy = useCopy()
  const hasHan = useDraftHasHan(getEditor, ready)
  const [busy, setBusy] = useState(false)

  const convert = async () => {
    const editor = getEditor()
    if (!editor || editor.isDestroyed || !editor.isEditable) return
    setBusy(true)
    try {
      const converter = await loadS2TWP()
      if (editor.isDestroyed) return
      const result = convertComposerText(editor, converter)
      if (!result.changed) {
        toast(copy.nothing)
        return
      }
      toast(copy.done, {
        action: {
          label: copy.undo,
          onClick: () => {
            undoConversion(editor, result.doc)
          },
        },
      })
    } catch {
      toast.error(copy.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
      title={copy.label}
      aria-label={copy.label}
      disabled={disabled || busy || !hasHan}
      // 不搶 editor 的焦點：手機上鍵盤不會因為按這顆而收起
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void convert()}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <span aria-hidden className="text-[15px] leading-none font-medium">
          繁
        </span>
      )}
    </Button>
  )
}
