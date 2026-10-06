import { Editor } from "@tiptap/core"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildComposerExtensions } from "@/components/chat/composer/editor-config"

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
// 按鈕的測試不載入真的字典（見 s2twp.test.ts）
vi.mock("@/lib/fork/s2twp", () => ({
  loadS2TWP: async () => (s: string) =>
    s.replace(/这/g, "這").replace(/说/g, "說"),
}))

import { ConvertToTraditionalButton } from "./convert-to-traditional-button"

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: buildComposerExtensions() })
  toast.mockClear()
  toast.error.mockClear()
})

afterEach(() => {
  editor.destroy()
})

function renderButton() {
  render(
    <NextIntlClientProvider locale="zh-TW" messages={{}}>
      <ConvertToTraditionalButton getEditor={() => editor} ready />
    </NextIntlClientProvider>
  )
  return screen.getByRole("button", { name: "轉為繁體（臺灣用語）" })
}

const plain = () => editor.state.doc.textContent

describe("ConvertToTraditionalButton", () => {
  it("is disabled until the draft has Chinese text", () => {
    const button = renderButton()
    expect(button).toBeDisabled()
    act(() => {
      editor.commands.setContent("<p>hello</p>")
    })
    expect(button).toBeDisabled()
    act(() => {
      editor.commands.setContent("<p>这个怎么说</p>")
    })
    expect(button).toBeEnabled()
  })

  it("converts the draft and offers an undo", async () => {
    act(() => {
      editor.commands.setContent("<p>这个怎么说</p>")
    })
    const button = renderButton()
    fireEvent.click(button)
    await waitFor(() => expect(plain()).toBe("這个怎么說"))

    expect(toast).toHaveBeenCalledTimes(1)
    const [message, options] = toast.mock.calls[0]
    expect(message).toBe("已轉為繁體")
    expect(options.action.label).toBe("復原")
    act(() => options.action.onClick())
    expect(plain()).toBe("这个怎么说")
  })

  it("says so when there is nothing to convert", async () => {
    act(() => {
      editor.commands.setContent("<p>已經是繁體</p>")
    })
    fireEvent.click(renderButton())
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("沒有需要轉換的簡體字")
    )
    expect(plain()).toBe("已經是繁體")
  })

  it("keeps the editor focused when pressed", () => {
    act(() => {
      editor.commands.setContent("<p>这个</p>")
    })
    const button = renderButton()
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
