import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildComposerExtensions } from "@/components/chat/composer/editor-config"

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

// 按鈕的測試不載入真的字典（引擎見 @/lib/fork/zh-tw 的測試）。load 可以
// 換掉，用來模擬「還沒載入完」與「載入失敗」。
type Convert = { convert: (s: string) => string }
const fake: Convert = {
  convert: (s) => s.replace(/这/g, "這").replace(/说/g, "說"),
}
const s2t = vi.hoisted(() => ({
  loaded: null as { convert: (s: string) => string } | null,
  load: null as (() => Promise<{ convert: (s: string) => string }>) | null,
}))
vi.mock("@/lib/fork/zh-tw/load", async () => {
  const { taiwanPunctuation } = await import("@/lib/fork/taiwan-punctuation")
  return {
    loadZhTw: () => s2t.load!(),
    getLoadedZhTw: () => s2t.loaded,
    draftConverter: (zh: Convert) => (text: string) =>
      taiwanPunctuation(zh.convert(text)),
  }
})

import {
  resetConvertOnSendCache,
  setConvertOnSend,
} from "@/lib/fork/convert-on-send"
import { resetZhTwSettingsCache } from "@/lib/fork/zh-tw/settings"
import {
  ConvertToTraditionalButton,
  useSendAsTraditional,
} from "./convert-to-traditional-button"

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: buildComposerExtensions() })
  toast.mockClear()
  toast.error.mockClear()
  s2t.loaded = null
  s2t.load = async () => {
    s2t.loaded = fake
    return fake
  }
  localStorage.clear()
  resetConvertOnSendCache()
  resetZhTwSettingsCache()
})

afterEach(() => {
  // 先卸載元件再銷毀 editor：反過來的話，元件會在測試外收到 destroy 事件
  cleanup()
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
    await act(async () => {
      fireEvent.click(button)
    })
    expect(plain()).toBe("這个怎么說")

    expect(toast).toHaveBeenCalledTimes(1)
    const [message, options] = toast.mock.calls[0]
    expect(message).toBe("已轉為繁體")
    expect(options.action.label).toBe("復原")
    act(() => options.action.onClick())
    expect(plain()).toBe("这个怎么说")
  })

  it("also converts punctuation to the Taiwanese forms", async () => {
    act(() => {
      editor.commands.setContent("<p>他说：“这个——好,对吧?”</p>")
    })
    const button = renderButton()
    await act(async () => {
      fireEvent.click(button)
    })
    expect(plain()).toBe("他說：「這个──好，对吧？」")
  })

  it("says so when there is nothing to convert", async () => {
    act(() => {
      editor.commands.setContent("<p>已經是繁體</p>")
    })
    const button = renderButton()
    await act(async () => {
      fireEvent.click(button)
    })
    expect(toast).toHaveBeenCalledWith("沒有需要轉換的簡體字或標點")
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

describe("convert-before-sending switch", () => {
  it("is off by default and turns on from the menu next to the button", async () => {
    const user = userEvent.setup()
    act(() => {
      editor.commands.setContent("<p>这个</p>")
    })
    const button = renderButton()
    expect(button).not.toHaveAttribute(
      "title",
      expect.stringContaining("傳送前")
    )

    await user.click(screen.getByRole("button", { name: "繁體轉換選項" }))
    const item = await screen.findByRole("menuitemcheckbox", {
      name: /傳送前自動轉為繁體/,
    })
    expect(item).toHaveAttribute("aria-checked", "false")
    await user.click(item)

    expect(toast).toHaveBeenCalledWith("已開啟：傳送前自動轉為繁體")
    expect(localStorage.getItem("codeg_fork_convert_on_send")).toBe("1")
    expect(button).toHaveAttribute(
      "title",
      "轉為繁體（臺灣用語） · 傳送前會自動轉為繁體"
    )
    // 按鈕本身照舊是立即轉換
    await act(async () => {
      fireEvent.click(button)
    })
    expect(plain()).toBe("這个")
  })
})

describe("conversion options menu", () => {
  it("switches the live preview and the wording, and remembers both on this device", async () => {
    const user = userEvent.setup()
    renderButton()
    await user.click(screen.getByRole("button", { name: "繁體轉換選項" }))
    const preview = await screen.findByRole("menuitemcheckbox", {
      name: /同步預覽/,
    })
    expect(preview).toHaveAttribute("aria-checked", "true")
    const everyday = screen.getByRole("menuitemradio", { name: /日常/ })
    expect(everyday).toHaveAttribute("aria-checked", "true")
    await user.click(screen.getByRole("menuitemradio", { name: /正式/ }))
    expect(localStorage.getItem("codeg_fork_zh_tw_style")).toBe("formal")

    await user.click(screen.getByRole("button", { name: "繁體轉換選項" }))
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /同步預覽/ })
    )
    expect(localStorage.getItem("codeg_fork_zh_tw_preview")).toBe("0")
  })

  it("opens the personal dictionary, where words can be added and removed", async () => {
    const user = userEvent.setup()
    renderButton()
    await user.click(screen.getByRole("button", { name: "繁體轉換選項" }))
    await user.click(await screen.findByRole("menuitem", { name: "個人詞庫" }))
    const dialog = await screen.findByRole("dialog", { name: "個人詞庫" })
    expect(dialog).toHaveTextContent("還沒有詞")

    await user.type(
      screen.getByRole("textbox", { name: "原文（簡體）" }),
      "原生态"
    )
    await user.type(screen.getByRole("textbox", { name: "寫成" }), "道地")
    await user.click(screen.getByRole("button", { name: "加入" }))
    expect(
      JSON.parse(localStorage.getItem("codeg_fork_zh_tw_personal")!)
    ).toEqual([["原生态", "道地"]])
    expect(dialog).toHaveTextContent("原生态→道地")

    await user.click(screen.getByRole("button", { name: "移除「原生态」" }))
    expect(localStorage.getItem("codeg_fork_zh_tw_personal")).toBeNull()
  })
})

describe("useSendAsTraditional", () => {
  // 傳送當下草稿長什麼樣子
  let sent: string[]
  const send = vi.fn(() => {
    sent.push(plain())
  })

  beforeEach(() => {
    sent = []
    send.mockClear()
  })

  function Harness() {
    const handleSend = useSendAsTraditional(send, () => editor)
    return (
      <button type="button" onClick={() => handleSend()}>
        send
      </button>
    )
  }

  function renderHarness() {
    render(
      <NextIntlClientProvider locale="zh-TW" messages={{}}>
        <Harness />
      </NextIntlClientProvider>
    )
    return screen.getByRole("button", { name: "send" })
  }

  it("sends the draft as typed while the switch is off", () => {
    act(() => {
      editor.commands.setContent("<p>这个怎么说</p>")
    })
    fireEvent.click(renderHarness())
    expect(sent).toEqual(["这个怎么说"])
  })

  it("converts the whole draft, selection or not, before sending", () => {
    setConvertOnSend(true)
    s2t.loaded = fake
    act(() => {
      editor.commands.setContent("<p>这个怎么说</p>")
      // 只選了「这」：自動轉換仍轉整則
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, 1, 2)
        )
      )
    })
    fireEvent.click(renderHarness())
    // 轉換器已載入：同步轉換、同步傳送
    expect(sent).toEqual(["這个怎么說"])
  })

  it("waits for the converter the first time, and sends only once", async () => {
    setConvertOnSend(true)
    let resolve!: () => void
    let pending: Promise<Convert> | null = null
    s2t.load = () =>
      (pending ??= new Promise<Convert>((done) => {
        resolve = () => {
          s2t.loaded = fake
          done(fake)
        }
      }))
    act(() => {
      editor.commands.setContent("<p>这个</p>")
    })
    const button = renderHarness()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(send).not.toHaveBeenCalled()

    await act(async () => resolve())
    expect(sent).toEqual(["這个"])
  })

  it("keeps the draft and doesn't send when the converter fails to load", async () => {
    setConvertOnSend(true)
    s2t.load = async () => {
      throw new Error("chunk missing")
    }
    act(() => {
      editor.commands.setContent("<p>这个</p>")
    })
    fireEvent.click(renderHarness())
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("轉換器載入失敗，訊息沒有傳送")
    )
    expect(send).not.toHaveBeenCalled()
    expect(plain()).toBe("这个")
  })

  it("sends right away when there is no Chinese to convert", () => {
    setConvertOnSend(true)
    const load = vi.fn(s2t.load!)
    s2t.load = load
    act(() => {
      editor.commands.setContent("<p>hello</p>")
    })
    const button = renderHarness()
    load.mockClear()
    fireEvent.click(button)
    expect(sent).toEqual(["hello"])
    expect(load).not.toHaveBeenCalled()
  })
})
