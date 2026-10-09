import { Editor, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildComposerExtensions } from "@/components/chat/composer/editor-config"
import type { ReferenceAttrs } from "@/components/chat/composer/types"
import {
  codeMask,
  convertComposerText,
  hasHanText,
  undoConversion,
} from "./composer-to-traditional"

// 小型的假轉換器：這裡驗證的是「怎麼套用到編輯器」，不是字典內容
// （字典見 s2twp.test.ts）。「U盘」→「隨身碟」用來測長度改變。
const MAP: Record<string, string> = {
  这: "這",
  简: "簡",
  体: "體",
  数: "數",
  据: "據",
  说: "說",
}
const fake = (s: string) =>
  s.replace(/U盘/g, "隨身碟").replace(/[这简体数据说]/g, (c) => MAP[c] ?? c)

function ref(label: string): ReferenceAttrs {
  return { refType: "file", id: label, label, uri: null, meta: null }
}

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: buildComposerExtensions() })
})

afterEach(() => {
  editor.destroy()
})

function setParagraphs(...paragraphs: JSONContent[][]) {
  editor.commands.setContent({
    type: "doc",
    content: paragraphs.map((content) => ({ type: "paragraph", content })),
  })
}

const text = (t: string): JSONContent => ({ type: "text", text: t })
// 換行印成 \n，引用標籤印成 @
const plain = () =>
  editor.state.doc.textBetween(
    0,
    editor.state.doc.content.size,
    "\n",
    (node) => (node.type.name === "hardBreak" ? "\n" : "@")
  )

describe("convertComposerText", () => {
  it("converts the draft and leaves reference badges and line breaks alone", () => {
    setParagraphs(
      [
        text("看这个 "),
        { type: "reference", attrs: ref("数据.ts") },
        text(" 说明"),
      ],
      [text("简体"), { type: "hardBreak" }, text("数据")]
    )
    const result = convertComposerText(editor, fake)
    expect(result.changed).toBe(true)
    expect(plain()).toBe("看這个 @ 說明\n簡體\n數據")
    // 引用標籤的屬性（檔名裡的簡體字）完全不變
    const badge = editor.state.doc.firstChild!.child(1)
    expect(badge.type.name).toBe("reference")
    expect(badge.attrs.label).toBe("数据.ts")
  })

  it("never converts code between backticks", () => {
    setParagraphs(
      [text("改 `src/数据.ts` 里的说明")],
      [text("```")],
      [text("const 说明 = 1")],
      [text("```")],
      [text("这里 ``a`数`b`` 不变")]
    )
    convertComposerText(editor, fake)
    expect(plain()).toBe(
      "改 `src/数据.ts` 里的說明\n```\nconst 说明 = 1\n```\n這里 ``a`数`b`` 不变"
    )
  })

  it("converts only the selection when there is one, and keeps it selected", () => {
    setParagraphs([text("这里说这个")])
    // 選取「说这」（文件位置：段落從 1 開始）
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3, 5))
    )
    convertComposerText(editor, fake)
    expect(plain()).toBe("这里說這个")
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe("說這")
  })

  it("converts the whole draft regardless of the selection when asked", () => {
    setParagraphs([text("这里说这个")])
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3, 5))
    )
    convertComposerText(editor, fake, { wholeDraft: true })
    expect(plain()).toBe("這里說這个")
  })

  it("handles conversions that change the length", () => {
    setParagraphs([text("插U盘再说")])
    convertComposerText(editor, fake)
    expect(plain()).toBe("插隨身碟再說")
  })

  it("undoes the whole conversion in one step, separately from typing", () => {
    setParagraphs([text("这个")])
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "说")
    const result = convertComposerText(editor, fake)
    expect(plain()).toBe("這个說")

    expect(undoConversion(editor, result.doc)).toBe(true)
    expect(plain()).toBe("这个说")
  })

  it("does not undo once the draft has changed after the conversion", () => {
    setParagraphs([text("这个")])
    const result = convertComposerText(editor, fake)
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!")
    expect(undoConversion(editor, result.doc)).toBe(false)
    expect(plain()).toBe("這个!")
  })

  it("reports no change and leaves the document untouched when nothing converts", () => {
    setParagraphs([text("已經是繁體 and English")])
    const before = editor.state.doc
    const result = convertComposerText(editor, fake)
    expect(result.changed).toBe(false)
    expect(editor.state.doc).toBe(before)
  })
})

describe("hasHanText", () => {
  it("is true only when the draft holds Chinese characters", () => {
    setParagraphs([text("only english")])
    expect(hasHanText(editor)).toBe(false)
    setParagraphs([text("有中文")])
    expect(hasHanText(editor)).toBe(true)
  })
})

describe("codeMask", () => {
  const masked = (s: string) =>
    [...codeMask(s)].map((m, i) => (m ? s[i] : "_")).join("")

  it("masks inline code and fenced blocks, not unmatched backticks", () => {
    expect(masked("a `b` c")).toBe("__`b`__")
    expect(masked("a ` b")).toBe("_____")
    // 換行本身不屬於任何一行，不標（編輯器裡換行也不是文字）
    expect(masked("```\nx\n```\ny")).toBe("```_x_```__")
  })
})
