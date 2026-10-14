// mobile fork：這則草稿在預覽裡點選過的寫法（原文 → 寫法），每個輸入框
// （editor）各自一份。預覽、「繁」按鈕與傳送前的自動轉換都讀它，所以預覽
// 看到的就是送出的。草稿清空（送出後）就忘掉。
import type { Editor } from "@tiptap/core"

const choices = new WeakMap<Editor, Map<string, string>>()
const listeners = new WeakMap<Editor, Set<() => void>>()
const EMPTY: ReadonlyMap<string, string> = new Map()

export function getDraftChoices(editor: Editor): ReadonlyMap<string, string> {
  return choices.get(editor) ?? EMPTY
}

/** 選定一段原文的寫法；text 為 null 表示回到預設。 */
export function setDraftChoice(
  editor: Editor,
  source: string,
  text: string | null
) {
  const next = new Map(choices.get(editor))
  if (text === null) next.delete(source)
  else next.set(source, text)
  choices.set(editor, next)
  for (const listener of listeners.get(editor) ?? []) listener()
}

export function clearDraftChoices(editor: Editor) {
  if (!choices.get(editor)?.size) return
  choices.delete(editor)
  for (const listener of listeners.get(editor) ?? []) listener()
}

export function subscribeDraftChoices(
  editor: Editor,
  listener: () => void
): () => void {
  let set = listeners.get(editor)
  if (!set) {
    set = new Set()
    listeners.set(editor, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}
