import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import {
  getConvertOnSend,
  resetConvertOnSendCache,
  setConvertOnSend,
  useConvertOnSend,
} from "./convert-on-send"

const KEY = "codeg_fork_convert_on_send"

beforeEach(() => {
  localStorage.clear()
  resetConvertOnSendCache()
})

describe("convert-on-send switch", () => {
  it("is off until turned on, and remembers it on this device", () => {
    expect(getConvertOnSend()).toBe(false)
    setConvertOnSend(true)
    expect(localStorage.getItem(KEY)).toBe("1")
    // 重新開啟頁面：從 localStorage 讀回來
    resetConvertOnSendCache()
    expect(getConvertOnSend()).toBe(true)
    setConvertOnSend(false)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("updates every composer at once, including other tabs", () => {
    const first = renderHook(() => useConvertOnSend())
    const second = renderHook(() => useConvertOnSend())
    expect(first.result.current).toBe(false)

    act(() => setConvertOnSend(true))
    expect(first.result.current).toBe(true)
    expect(second.result.current).toBe(true)

    // 另一個分頁關掉了
    act(() => {
      localStorage.removeItem(KEY)
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }))
    })
    expect(first.result.current).toBe(false)
    expect(second.result.current).toBe(false)
  })
})
