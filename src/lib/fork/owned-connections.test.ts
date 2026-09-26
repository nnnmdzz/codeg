import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 每次重新 import 模組，就等於一個新載入的頁面（新的 PAGE_ID）。
async function loadPage() {
  vi.resetModules()
  return import("./owned-connections")
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("owned-connections", () => {
  it("returns null for a connection this device never opened", async () => {
    const page = await loadPage()
    expect(page.ownedConnectionInfo("c1")).toBeNull()
    expect(page.canClaimOwnedConnection("c1")).toBe(false)
    expect(page.isClaimedByAnotherPage("c1")).toBe(false)
  })

  it("lets a reloaded page claim a connection its predecessor opened", async () => {
    const first = await loadPage()
    first.recordOwnedConnection("c1")
    window.dispatchEvent(new Event("pagehide"))

    const second = await loadPage()
    expect(second.canClaimOwnedConnection("c1")).toBe(true)
    second.claimOwnedConnection("c1")
    expect(second.isClaimedByAnotherPage("c1")).toBe(false)
  })

  it("stays a viewer while the opening page is still alive", async () => {
    const first = await loadPage()
    first.recordOwnedConnection("c1")

    const second = await loadPage()
    expect(second.canClaimOwnedConnection("c1")).toBe(false)
    expect(second.ownedConnectionInfo("c1")).not.toBeNull()
  })

  it("treats a page with a stale heartbeat as gone", async () => {
    const first = await loadPage()
    first.recordOwnedConnection("c1")
    // 背景分頁被凍結：計時器停擺，心跳不再更新。
    vi.clearAllTimers()
    vi.setSystemTime(Date.now() + 31_000)

    const second = await loadPage()
    expect(second.canClaimOwnedConnection("c1")).toBe(true)
  })

  it("stops the original page from disconnecting a claimed connection", async () => {
    const first = await loadPage()
    first.recordOwnedConnection("c1")
    const firstIsClaimed = first.isClaimedByAnotherPage
    window.dispatchEvent(new Event("pagehide"))

    const second = await loadPage()
    second.claimOwnedConnection("c1")
    expect(firstIsClaimed("c1")).toBe(true)
  })
})
