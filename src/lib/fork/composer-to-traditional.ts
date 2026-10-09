// mobile fork：把 composer 的草稿轉成繁體（轉換器見 ./s2twp）。
//
// 只動文字節點：引用標籤（@ 檔案等）是獨立的 atom 節點，原樣保留。反引號裡的
// 程式碼不轉——整段 ``` 區塊（含圍欄那兩行）與行內 `x`——路徑、識別字、字串
// 常值改了就錯。有選取時只轉選取的範圍（傳送前的自動轉換例外，一律轉整則）。
//
// 整次轉換是一筆獨立的編輯紀錄（closeHistory，不併入前面的輸入），按一次
// 復原就剛好還原；每段只替換頭尾實際不同的部分，游標所在的字沒變就不會被
// 移動，選取範圍也跟著內容保留。
import type { Editor } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model"

const HAN = /\p{Script=Han}/u

/** 草稿裡有沒有漢字——沒有就沒什麼可轉。 */
export function hasHanText(editor: Editor): boolean {
  return HAN.test(editor.state.doc.textContent)
}

interface TextPiece {
  /** 文字節點在文件裡的起點 */
  pos: number
  /** 在攤平字串裡的起點 */
  start: number
  length: number
  marks: readonly Mark[]
}

/**
 * 把文件攤平成一行行的文字（段落與換行都是一行，其他行內節點以 U+FFFC
 * 佔位），並記下每個文字節點在其中的位置。程式碼的判斷以行為單位，所以
 * 需要看到整份文件，而不是一個個文字節點。
 */
function flatten(doc: ProseMirrorNode): { flat: string; pieces: TextPiece[] } {
  let flat = ""
  let firstBlock = true
  const pieces: TextPiece[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!firstBlock) flat += "\n"
      firstBlock = false
      return true
    }
    if (node.isText) {
      const text = node.text ?? ""
      pieces.push({
        pos,
        start: flat.length,
        length: text.length,
        marks: node.marks,
      })
      flat += text
      return false
    }
    if (node.type.name === "hardBreak") {
      flat += "\n"
      return false
    }
    if (node.isLeaf) {
      flat += "\uFFFC"
      return false
    }
    return true
  })
  return { flat, pieces }
}

/**
 * 標出不轉的字元（1）：反引號包住的程式碼。以 ``` 開頭的行切換圍欄區塊
 * （圍欄行本身也不轉）；區塊外，同一行裡成對的反引號（長度相同）之間是
 * 行內程式碼。沒有配對的反引號照一般文字處理。
 */
export function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)
  let inFence = false
  let lineStart = 0
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length
    if (line.trimStart().startsWith("```")) {
      mask.fill(1, lineStart, lineEnd)
      inFence = !inFence
    } else if (inFence) {
      mask.fill(1, lineStart, lineEnd)
    } else {
      let i = 0
      while (i < line.length) {
        if (line[i] !== "`") {
          i++
          continue
        }
        let j = i
        while (j < line.length && line[j] === "`") j++
        const close = line.indexOf(line.slice(i, j), j)
        if (close === -1) {
          i = j
          continue
        }
        const end = close + (j - i)
        mask.fill(1, lineStart + i, lineStart + end)
        i = end
      }
    }
    lineStart = lineEnd + 1
  }
  return mask
}

export interface ConversionResult {
  /** 有沒有任何字被換掉 */
  changed: boolean
  /** 轉換後的文件；草稿之後沒再變過，才能用它判斷復原是否還適用 */
  doc: ProseMirrorNode
}

export function convertComposerText(
  editor: Editor,
  convert: (text: string) => string,
  /** wholeDraft：不管選取，轉整則草稿 */
  options: { wholeDraft?: boolean } = {}
): ConversionResult {
  const { state } = editor
  const { flat, pieces } = flatten(state.doc)
  const mask = codeMask(flat)
  const { from, to } = state.selection
  const empty = options.wholeDraft === true || state.selection.empty

  const edits: {
    from: number
    to: number
    text: string
    marks: readonly Mark[]
  }[] = []
  for (const piece of pieces) {
    const convertible = (k: number) =>
      mask[piece.start + k] === 0 &&
      (empty || (piece.pos + k >= from && piece.pos + k < to))
    let i = 0
    while (i < piece.length) {
      if (!convertible(i)) {
        i++
        continue
      }
      let j = i
      while (j < piece.length && convertible(j)) j++
      const original = flat.slice(piece.start + i, piece.start + j)
      const converted = convert(original)
      if (converted !== original) {
        let a = 0
        while (
          a < original.length &&
          a < converted.length &&
          original[a] === converted[a]
        ) {
          a++
        }
        let b = 0
        while (
          b < original.length - a &&
          b < converted.length - a &&
          original[original.length - 1 - b] ===
            converted[converted.length - 1 - b]
        ) {
          b++
        }
        edits.push({
          from: piece.pos + i + a,
          to: piece.pos + j - b,
          text: converted.slice(a, converted.length - b),
          marks: piece.marks,
        })
      }
      i = j
    }
  }

  if (edits.length === 0) return { changed: false, doc: state.doc }

  const tr = state.tr
  for (const edit of edits) {
    const editFrom = tr.mapping.map(edit.from)
    const editTo = tr.mapping.map(edit.to)
    if (edit.text) {
      tr.replaceWith(editFrom, editTo, state.schema.text(edit.text, edit.marks))
    } else {
      tr.delete(editFrom, editTo)
    }
  }
  closeHistory(tr)
  editor.view.dispatch(tr)
  return { changed: true, doc: editor.state.doc }
}

/** 剛轉完、草稿之後沒再被改過時，復原這次轉換；否則不動，回傳 false。 */
export function undoConversion(
  editor: Editor,
  after: ProseMirrorNode
): boolean {
  if (editor.isDestroyed || !editor.state.doc.eq(after)) return false
  return editor.commands.undo()
}
