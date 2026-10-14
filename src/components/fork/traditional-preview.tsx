"use client"

// mobile fork：轉繁體的同步預覽。不送上游。
//
// 草稿裡有簡體時，在輸入框下方顯示轉成繁體（臺灣用語與標點）後的樣子——跟
// 按「繁」或傳送前自動轉換的結果逐字相同：切段、選項與標點都走同一條路
// （@/lib/fork/composer-to-traditional 的 draftSegments、@/lib/fork/zh-tw/load
// 的 draftOptions）。
//
// 引擎有拿不準、或有別的說法的地方加上點狀底線，點一下列出原文與各種寫法：
// 選了只套用在這則草稿（@/lib/fork/zh-tw/draft-choices）；「以後都這樣轉」
// 加進個人詞庫。同一個詞第二次選同一種非預設寫法時，提議記住它。
//
// 點選不搶 editor 的焦點，手機上鍵盤不會收起來。
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Editor } from "@tiptap/core"
import { Check, Languages } from "lucide-react"
import { useLocale } from "next-intl"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { draftSegments } from "@/lib/fork/composer-to-traditional"
import { taiwanPunctuation } from "@/lib/fork/taiwan-punctuation"
import {
  clearDraftChoices,
  setDraftChoice,
  subscribeDraftChoices,
} from "@/lib/fork/zh-tw/draft-choices"
import type { Piece, ZhTwEngine } from "@/lib/fork/zh-tw/engine"
import {
  draftOptions,
  getLoadedZhTw,
  loadZhTw,
  subscribeZhTwLoaded,
} from "@/lib/fork/zh-tw/load"
import {
  addPersonalRule,
  personalSetting,
  previewSetting,
  recordPick,
  removePersonalRule,
  styleSetting,
} from "@/lib/fork/zh-tw/settings"
import { cn } from "@/lib/utils"

const COPY = {
  "zh-TW": {
    region: "轉成繁體後的樣子",
    title: "繁體預覽",
    source: "原文",
    usual: "預設",
    remember: "以後都這樣轉",
    remembered: (s: string, t: string) => `已加入個人詞庫：${s} → ${t}`,
    forget: "從個人詞庫移除",
    learn: (s: string, t: string) => `以後「${s}」都轉成「${t}」嗎？`,
    learnYes: "好",
    choice: (t: string, s: string) => `${t}，原文「${s}」，點選可換寫法`,
  },
  "zh-CN": {
    region: "转成繁体后的样子",
    title: "繁体预览",
    source: "原文",
    usual: "默认",
    remember: "以后都这样转",
    remembered: (s: string, t: string) => `已加入个人词库：${s} → ${t}`,
    forget: "从个人词库移除",
    learn: (s: string, t: string) => `以后“${s}”都转成“${t}”吗？`,
    learnYes: "好",
    choice: (t: string, s: string) => `${t}，原文“${s}”，点选可换写法`,
  },
  en: {
    region: "How the message reads in Traditional Chinese",
    title: "Traditional preview",
    source: "Original",
    usual: "Default",
    remember: "Always convert it this way",
    remembered: (s: string, t: string) =>
      `Added to your dictionary: ${s} → ${t}`,
    forget: "Remove from your dictionary",
    learn: (s: string, t: string) => `Always convert “${s}” to “${t}”?`,
    learnYes: "Yes",
    choice: (t: string, s: string) =>
      `${t}, from “${s}”; choose another wording`,
  },
} as const

type Copy = (typeof COPY)[keyof typeof COPY]

function useCopy(): Copy {
  const locale = useLocale()
  return locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
}

/** 目前的 editor；它重建（destroy）時跟著換。 */
function useEditorInstance(
  getEditor: () => Editor | null,
  ready: boolean
): Editor | null {
  const getEditorRef = useRef(getEditor)
  useEffect(() => {
    getEditorRef.current = getEditor
  }, [getEditor])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!ready) return
    const current = getEditorRef.current()
    if (!current || current.isDestroyed) {
      const retry = window.setTimeout(() => setAttempt((n) => n + 1), 200)
      return () => window.clearTimeout(retry)
    }
    setEditor(current)
    const rebind = () => {
      setEditor(null)
      setAttempt((n) => n + 1)
    }
    current.on("destroy", rebind)
    return () => {
      current.off("destroy", rebind)
    }
  }, [ready, attempt])
  return editor
}

/** 草稿內容或點選過的寫法變了就加一（輸入時稍微延後，不必每個字都重算）。 */
function useDraftVersion(editor: Editor | null): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!editor) return
    let timer: number | undefined
    const bump = () => setVersion((n) => n + 1)
    const onUpdate = () => {
      // 送出後草稿清空：這則草稿的選擇也忘掉
      if (editor.isEmpty) clearDraftChoices(editor)
      window.clearTimeout(timer)
      timer = window.setTimeout(bump, 120)
    }
    editor.on("update", onUpdate)
    const unsubscribe = subscribeDraftChoices(editor, bump)
    return () => {
      window.clearTimeout(timer)
      editor.off("update", onUpdate)
      unsubscribe()
    }
  }, [editor])
  return version
}

/**
 * joined（標點轉換前）每個位置在 final（標點轉換後）裡的位置。標點轉換只換
 * 標點、偶爾刪掉全形標點後面的一個半形空格，所以逐字對得起來。
 */
function alignPunctuation(joined: string, final: string): number[] {
  const map = new Array<number>(joined.length + 1)
  let j = 0
  for (let i = 0; i < joined.length; i++) {
    map[i] = j
    if (joined[i] === final[j]) j++
    else if (joined[i] === " ")
      continue // 被刪掉的空格
    else j++ // 被換掉的標點
  }
  map[joined.length] = final.length
  return map
}

type PreviewNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "choice"; text: string; piece: Piece }
  | { kind: "leaf"; label: string }
  | { kind: "break" }

/** 草稿 → 預覽的內容；沒有要轉的簡體時為 null */
function buildPreview(zh: ZhTwEngine, editor: Editor): PreviewNode[] | null {
  const segments = draftSegments(editor.state.doc)
  if (
    !segments.some(
      (s) => s.kind === "text" && s.convert && zh.hasSimplified(s.text)
    )
  ) {
    return null
  }
  const options = draftOptions(zh, editor)
  const nodes: PreviewNode[] = []
  for (const segment of segments) {
    if (segment.kind !== "text") {
      nodes.push(segment)
      continue
    }
    if (!segment.convert) {
      nodes.push({ kind: "code", text: segment.text })
      continue
    }
    const pieces = zh.pieces(segment.text, options)
    const joined = pieces.map((p) => p.text).join("")
    const final = taiwanPunctuation(joined)
    const map = alignPunctuation(joined, final)
    let offset = 0
    let cursor = 0
    for (const piece of pieces) {
      const start = map[offset]
      const end = map[offset + piece.text.length]
      offset += piece.text.length
      if (!piece.options) continue
      if (start > cursor)
        nodes.push({ kind: "text", text: final.slice(cursor, start) })
      nodes.push({ kind: "choice", text: final.slice(start, end), piece })
      cursor = end
    }
    if (cursor < final.length)
      nodes.push({ kind: "text", text: final.slice(cursor) })
  }
  return nodes
}

function Choice({
  editor,
  node,
  copy,
  personal,
}: {
  editor: Editor
  node: Extract<PreviewNode, { kind: "choice" }>
  copy: Copy
  personal: ReadonlyMap<string, string>
}) {
  const [open, setOpen] = useState(false)
  const { piece } = node
  const options = piece.options ?? []
  const fromDictionary = piece.reason === "personal"

  const choose = (text: string) => {
    const usual = options[0]
    setDraftChoice(editor, piece.source, text === usual ? null : text)
    setOpen(false)
    if (text === usual || fromDictionary || personal.get(piece.source) === text)
      return
    // 同一個詞第二次選同一種非預設寫法：提議記住
    if (recordPick(piece.source, text) === 2) {
      toast(copy.learn(piece.source, text), {
        action: {
          label: copy.learnYes,
          onClick: () => addPersonalRule(piece.source, text),
        },
      })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={copy.choice(node.text, piece.source)}
          // 不搶 editor 的焦點：手機上鍵盤不會收起來
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            "rounded-[3px] underline underline-offset-4 transition-colors hover:bg-foreground/[0.06]",
            piece.chosen || fromDictionary
              ? "text-primary decoration-primary decoration-solid"
              : "decoration-muted-foreground/60 decoration-dotted hover:decoration-foreground"
          )}
        >
          {node.text}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        className="w-auto min-w-44 max-w-72 gap-1 p-1.5 text-sm"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">
          {copy.source}　{piece.source}
        </div>
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}
            className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
          >
            <Check
              aria-hidden
              className={cn(
                "size-3.5 shrink-0",
                option === piece.text ? "opacity-100" : "opacity-0"
              )}
            />
            <span className="text-[15px]">{option}</span>
            {index === 0 && (
              <span className="ml-auto pl-3 text-xs text-muted-foreground">
                {copy.usual}
              </span>
            )}
          </button>
        ))}
        <div className="mt-0.5 border-t pt-1">
          {fromDictionary ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                removePersonalRule(piece.source)
                setOpen(false)
              }}
              className="h-8 w-full rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copy.forget}
            </button>
          ) : (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                addPersonalRule(piece.source, piece.text)
                setDraftChoice(editor, piece.source, null)
                setOpen(false)
                toast(copy.remembered(piece.source, piece.text))
              }}
              className="h-8 w-full rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copy.remember}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function TraditionalPreview({
  getEditor,
  ready,
}: {
  getEditor: () => Editor | null
  ready: boolean
}) {
  const copy = useCopy()
  const enabled = previewSetting.use()
  // 寫法、個人詞庫、草稿內容與點選一變就重新渲染；buildPreview 讀它們的目前值
  styleSetting.use()
  const personal = personalSetting.use()
  const editor = useEditorInstance(getEditor, ready)
  useDraftVersion(editor)
  const zh = useSyncExternalStore(
    subscribeZhTwLoaded,
    getLoadedZhTw,
    () => null
  )

  // 開著預覽、草稿有漢字時才載入引擎（字典是獨立的 chunk）
  const hasHan = editor
    ? /\p{Script=Han}/u.test(editor.state.doc.textContent)
    : false
  useEffect(() => {
    if (enabled && hasHan && !zh) {
      loadZhTw().catch(() => {})
    }
  }, [enabled, hasHan, zh])

  const nodes =
    enabled && zh && editor && !editor.isDestroyed
      ? buildPreview(zh, editor)
      : null
  if (!nodes || !editor) return null

  return (
    <div className="px-3 pb-1.5" role="group" aria-label={copy.region}>
      <div className="flex max-h-24 gap-2 overflow-y-auto rounded-lg bg-muted/50 px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground/80">
        <Languages
          aria-hidden
          className="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
        />
        <p
          className="min-w-0 flex-1 whitespace-pre-wrap break-words"
          title={copy.title}
        >
          {nodes.map((node, index) => {
            switch (node.kind) {
              case "text":
                return <span key={index}>{node.text}</span>
              case "code":
                return (
                  <span
                    key={index}
                    className="font-mono text-[12px] text-muted-foreground"
                  >
                    {node.text}
                  </span>
                )
              case "leaf":
                return (
                  <span
                    key={index}
                    className="mx-0.5 rounded bg-background px-1 text-[12px] text-muted-foreground"
                  >
                    {node.label}
                  </span>
                )
              case "break":
                return <br key={index} />
              case "choice":
                return (
                  <Choice
                    key={index}
                    editor={editor}
                    node={node}
                    copy={copy}
                    personal={personal}
                  />
                )
            }
          })}
        </p>
      </div>
    </div>
  )
}
