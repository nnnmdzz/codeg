"use client"

// mobile fork：composer 送出鍵旁的「轉為繁體（台灣用語）」按鈕。不送上游。
//
// 有選取時只轉選取的文字，否則轉整則草稿；引用標籤與反引號裡的程式碼不轉
// （見 @/lib/fork/composer-to-traditional）。字轉完後，標點也換成臺灣的寫法
// （@/lib/fork/taiwan-punctuation）。轉換器第一次按下時才載入
// （@/lib/fork/s2twp）。轉完的提示帶「復原」，按一次就整筆還原。
//
// 旁邊的箭頭打開選單，切換「傳送前自動轉為繁體」（@/lib/fork/convert-on-send）。
// 開啟時「繁」改用主色並加底線；傳送時由 useSendAsTraditional 先轉整則草稿。
//
// 與 composer 的耦合只有 message-input 傳進來的兩樣東西：取得 Tiptap editor
// 的函式，以及 editor 是否已建立；再加上用 useSendAsTraditional 包住它的
// 傳送函式。草稿變化自己向 editor 訂閱，不經過 message-input 的狀態。
import { useCallback, useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/core"
import { ChevronUp, Loader2 } from "lucide-react"
import { useLocale } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  convertComposerText,
  hasHanText,
  undoConversion,
} from "@/lib/fork/composer-to-traditional"
import { setConvertOnSend, useConvertOnSend } from "@/lib/fork/convert-on-send"
import { getLoadedS2TWP, loadS2TWP } from "@/lib/fork/s2twp"
import { taiwanPunctuation } from "@/lib/fork/taiwan-punctuation"
import { cn } from "@/lib/utils"

// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-TW": {
    label: "轉為繁體（臺灣用語）",
    done: "已轉為繁體",
    undo: "復原",
    nothing: "沒有需要轉換的簡體字或標點",
    failed: "轉換器載入失敗，請稍後再試",
    options: "繁體轉換選項",
    onSend: "傳送前自動轉為繁體",
    onSendHint:
      "傳送時先把整則訊息轉成繁體（臺灣用語與標點）；引用標籤與反引號裡的程式碼不轉。",
    onSendActive: "傳送前會自動轉為繁體",
    turnedOn: "已開啟：傳送前自動轉為繁體",
    turnedOff: "已關閉：傳送前自動轉為繁體",
    sendFailed: "轉換器載入失敗，訊息沒有傳送",
  },
  "zh-CN": {
    label: "转为繁体（台湾用语）",
    done: "已转为繁体",
    undo: "撤销",
    nothing: "没有需要转换的简体字或标点",
    failed: "转换器加载失败，请稍后再试",
    options: "繁体转换选项",
    onSend: "发送前自动转为繁体",
    onSendHint:
      "发送时先把整条消息转成繁体（台湾用语与标点）；引用标签与反引号里的代码不转。",
    onSendActive: "发送前会自动转为繁体",
    turnedOn: "已开启：发送前自动转为繁体",
    turnedOff: "已关闭：发送前自动转为繁体",
    sendFailed: "转换器加载失败，消息没有发送",
  },
  en: {
    label: "Convert to Traditional Chinese (Taiwan)",
    done: "Converted to Traditional Chinese",
    undo: "Undo",
    nothing: "Nothing to convert",
    failed: "Couldn't load the converter. Try again shortly.",
    options: "Traditional Chinese options",
    onSend: "Convert to Traditional before sending",
    onSendHint:
      "Sending converts the whole message to Traditional Chinese (Taiwan wording and punctuation) first. Reference badges and code in backticks are left alone.",
    onSendActive: "Messages are converted to Traditional before sending",
    turnedOn: "On: convert to Traditional before sending",
    turnedOff: "Off: messages are sent as typed",
    sendFailed: "Couldn't load the converter, so the message wasn't sent.",
  },
} as const

/** 字轉成繁體（臺灣用語）之後，標點也換成臺灣的寫法 */
function toTaiwan(convert: (text: string) => string) {
  return (text: string) => taiwanPunctuation(convert(text))
}

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
  const onSend = useConvertOnSend()
  const [busy, setBusy] = useState(false)

  const convert = async () => {
    const editor = getEditor()
    if (!editor || editor.isDestroyed || !editor.isEditable) return
    setBusy(true)
    try {
      const converter = await loadS2TWP()
      if (editor.isDestroyed) return
      const result = convertComposerText(editor, toTaiwan(converter))
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

  const label = onSend ? `${copy.label} · ${copy.onSendActive}` : copy.label

  return (
    <div className="flex items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-8 w-8 rounded-r-none",
          onSend
            ? "text-primary hover:text-primary"
            : "text-muted-foreground hover:text-foreground"
        )}
        title={label}
        aria-label={copy.label}
        disabled={disabled || busy || !hasHan}
        // 不搶 editor 的焦點：手機上鍵盤不會因為按這顆而收起
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void convert()}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "text-[15px] leading-none font-medium",
              // 開啟「傳送前自動轉換」時加底線，跟只是游標移過去的樣子分得開
              onSend &&
                "underline decoration-2 underline-offset-[5px] font-semibold"
            )}
          >
            繁
          </span>
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-5 rounded-l-none text-muted-foreground hover:text-foreground"
            title={copy.options}
            aria-label={copy.options}
          >
            <ChevronUp className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="w-72"
          // 關掉後不把焦點留在箭頭上
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuCheckboxItem
            checked={onSend}
            onCheckedChange={(checked) => {
              setConvertOnSend(checked)
              toast(checked ? copy.turnedOn : copy.turnedOff)
            }}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span>{copy.onSend}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {copy.onSendHint}
              </span>
            </div>
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * 包住 composer 的傳送函式：開啟「傳送前自動轉為繁體」時，先把整則草稿
 * （不管選取）轉成繁體再傳送。送出、Enter、排隊、儲存排隊中的編輯、插話
 * 都經過它。
 *
 * 關閉、或草稿沒有漢字時原樣同步呼叫，與上游完全相同。開啟時轉換器已載入
 * 就同步轉換後傳送（開啟時會先載入）；還沒載入就等載入完，轉換後以當下
 * 最新的傳送函式送出，等待期間重複觸發不會重送。轉換器載入失敗時不傳送，
 * 草稿原樣保留——開了這個開關，就不該送出沒轉換的訊息。
 */
export function useSendAsTraditional<A extends unknown[]>(
  send: (...args: A) => unknown,
  getEditor: () => Editor | null
): (...args: A) => void {
  const copy = useCopy()
  const enabled = useConvertOnSend()
  const latest = useRef({ send, getEditor, copy })
  useEffect(() => {
    latest.current = { send, getEditor, copy }
  })
  const pending = useRef(false)

  // 開啟時先載入轉換器，傳送時就能同步轉換
  useEffect(() => {
    if (enabled) loadS2TWP().catch(() => {})
  }, [enabled])

  return useCallback(
    (...args: A) => {
      const editor = enabled ? latest.current.getEditor() : null
      if (!editor || editor.isDestroyed || !hasHanText(editor)) {
        send(...args)
        return
      }
      const converter = getLoadedS2TWP()
      if (converter) {
        convertComposerText(editor, toTaiwan(converter), { wholeDraft: true })
        send(...args)
        return
      }
      if (pending.current) return
      pending.current = true
      loadS2TWP()
        .then((loaded) => {
          const current = latest.current.getEditor()
          if (!current || current.isDestroyed) return
          convertComposerText(current, toTaiwan(loaded), { wholeDraft: true })
          latest.current.send(...args)
        })
        .catch(() => {
          toast.error(latest.current.copy.sendFailed)
        })
        .finally(() => {
          pending.current = false
        })
    },
    [enabled, send]
  )
}
