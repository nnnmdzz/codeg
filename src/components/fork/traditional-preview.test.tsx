import { Editor } from "@tiptap/core"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildComposerExtensions } from "@/components/chat/composer/editor-config"

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

import { convertComposerText } from "@/lib/fork/composer-to-traditional"
import { getDraftChoices } from "@/lib/fork/zh-tw/draft-choices"
import { draftConverter, loadZhTw } from "@/lib/fork/zh-tw/load"
import {
  personalSetting,
  previewSetting,
  resetZhTwSettingsCache,
  styleSetting,
} from "@/lib/fork/zh-tw/settings"
import { TraditionalPreview } from "./traditional-preview"

let editor: Editor

beforeEach(async () => {
  // 真的引擎與字典：預覽必須跟實際轉換逐字相同
  await loadZhTw()
  editor = new Editor({ extensions: buildComposerExtensions() })
  toast.mockClear()
  localStorage.clear()
  resetZhTwSettingsCache()
})

afterEach(() => {
  cleanup()
  editor.destroy()
})

function renderPreview() {
  render(
    <NextIntlClientProvider locale="zh-TW" messages={{}}>
      <TraditionalPreview getEditor={() => editor} ready />
    </NextIntlClientProvider>
  )
}

function type(html: string) {
  act(() => {
    editor.commands.setContent(html, { emitUpdate: true })
  })
}

const region = () => screen.queryByRole("group", { name: "轉成繁體後的樣子" })

const PLACEHOLDER = "輸入的文字會在這裡顯示成繁體"

/** 預覽顯示出草稿（不再是空草稿的提示）之後的文字 */
async function previewText() {
  await waitFor(() => {
    const text = region()?.textContent ?? ""
    expect(text).not.toBe("")
    expect(text).not.toContain(PLACEHOLDER)
  })
  return region()!.textContent
}

describe("TraditionalPreview", () => {
  it("is there as soon as it is on, with a hint while the draft is empty", () => {
    renderPreview()
    expect(region()).toHaveTextContent(PLACEHOLDER)
  })

  it("shows a draft that needs no conversion as it is, and says so", async () => {
    renderPreview()
    type("<p>這個項目已經是繁體</p>")
    expect(await previewText()).toBe("這個項目已經是繁體不需轉換")
    // 有要轉的字時就不註明
    type("<p>这个项目</p>")
    await waitFor(() => expect(region()).toHaveTextContent(/^這個專案$/))
  })

  it("shows exactly what converting would produce, punctuation included", async () => {
    renderPreview()
    type("<p>这个项目的代码有问题,帮我看看</p><p>运行 `npm test` 时报错</p>")
    const shown = await previewText()

    const zh = await loadZhTw()
    convertComposerText(editor, draftConverter(zh, editor))
    // 預覽把段落換成換行；轉完的草稿逐段比
    expect(shown).toBe(
      editor.state.doc.content.content.map((p) => p.textContent).join("")
    )
    expect(shown).toContain("這個專案的程式碼有問題，幫我看看")
    // 反引號裡的程式碼原樣
    expect(shown).toContain("`npm test`")
  })

  it("lets a word be changed for this draft, and converting uses that choice", async () => {
    const user = userEvent.setup()
    renderPreview()
    type("<p>这个项目的代码</p>")
    await previewText()

    await user.click(screen.getByRole("button", { name: /專案，原文「项目」/ }))
    await user.click(await screen.findByRole("button", { name: "項目" }))
    await waitFor(() => expect(region()!.textContent).toBe("這個項目的程式碼"))
    expect(getDraftChoices(editor).get("项目")).toBe("項目")

    const zh = await loadZhTw()
    convertComposerText(editor, draftConverter(zh, editor))
    expect(editor.state.doc.textContent).toBe("這個項目的程式碼")
  })

  it("remembers a wording in the personal dictionary when asked", async () => {
    const user = userEvent.setup()
    renderPreview()
    type("<p>好多任务失败了</p>")
    await previewText()

    await user.click(
      screen.getByRole("button", { name: /多任務，原文「多任务」/ })
    )
    await user.click(await screen.findByRole("button", { name: "多工" }))
    await user.click(
      screen.getByRole("button", { name: /多工，原文「多任务」/ })
    )
    await user.click(
      await screen.findByRole("button", { name: "以後都這樣轉" })
    )

    expect(personalSetting.get().get("多任务")).toBe("多工")
    expect(toast).toHaveBeenCalledWith("已加入個人詞庫：多任务 → 多工")
    await waitFor(() => expect(region()!.textContent).toBe("好多工失敗了"))
  })

  it("offers to remember a wording picked a second time", async () => {
    const user = userEvent.setup()
    renderPreview()
    for (const round of [1, 2]) {
      type(`<p>这个项目${"。".repeat(round)}</p>`)
      await previewText()
      await user.click(
        screen.getByRole("button", { name: /專案，原文「项目」/ })
      )
      await user.click(await screen.findByRole("button", { name: "項目" }))
      // 換下一則草稿：先清空（送出後的樣子）
      type("<p></p>")
    }
    expect(toast).toHaveBeenCalledTimes(1)
    const [message, options] = toast.mock.calls[0]
    expect(message).toBe("以後「项目」都轉成「項目」嗎？")
    act(() => options.action.onClick())
    expect(personalSetting.get().get("项目")).toBe("項目")
  })

  it("follows the wording setting and can be turned off", async () => {
    renderPreview()
    type("<p>这台电脑要优化一下</p>")
    expect(await previewText()).toBe("這台電腦要優化一下")
    act(() => styleSetting.set("formal"))
    await waitFor(() =>
      expect(region()!.textContent).toBe("這臺電腦要最佳化一下")
    )
    act(() => previewSetting.set(false))
    await waitFor(() => expect(region()).toBeNull())
  })
})
