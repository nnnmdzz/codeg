import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Updater = { state: string; elapsed: number | null; log: string[] }

const SERVER = "0.32.3"
let health: string
let status: { built: string; commit: string; updater: Updater }
let statusCode: number
let calls: { url: string; method: string; auth: string | null }[]

function json(body: unknown, code = 200) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  })
}

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  calls.push({
    url,
    method: init?.method ?? "GET",
    auth: headers.get("Authorization"),
  })
  if (url === "/api/health") return json({ status: "ok", version: health })
  if (statusCode !== 200) return json({ error: "x" }, statusCode)
  if (url === "/__fork/update") {
    status = {
      ...status,
      updater: { state: "running", elapsed: 0, log: ["rebasing ..."] },
    }
    return json({ server: SERVER, ...status }, 202)
  }
  return json({ server: SERVER, ...status })
})

async function renderWatermark(tag = "0.32.2") {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_CODEG_FORK_TAG", tag)
  vi.stubEnv("NEXT_PUBLIC_CODEG_FORK_COMMIT", "abc1234")
  const { ForkWatermark } = await import("./fork-watermark")
  render(
    <NextIntlClientProvider locale="zh-TW" messages={{}}>
      <ForkWatermark />
    </NextIntlClientProvider>
  )
  // health、status 兩個請求都回來
  await act(async () => {})
  await act(async () => {})
}

beforeEach(() => {
  localStorage.setItem("codeg_token", "tok")
  health = SERVER
  statusCode = 200
  status = {
    built: "0.32.2",
    commit: "abc1234",
    updater: { state: "idle", elapsed: null, log: [] },
  }
  calls = []
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("ForkWatermark", () => {
  it("is a plain, non-interactive watermark when the fork is current", async () => {
    await renderWatermark("0.32.3")
    expect(screen.getByText("dev fork · 0.32.3 · abc1234")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.startsWith("/__fork/"))).toBe(false)
  })

  it("offers an update when the server is ahead", async () => {
    await renderWatermark()
    const trigger = screen.getByRole("button", {
      name: "dev fork 0.32.2 → 0.32.3 · 點此更新",
    })
    fireEvent.click(trigger)
    await act(async () => {})
    expect(screen.getByText("fork 網頁有新版本")).toBeInTheDocument()
    expect(calls.find((c) => c.url === "/__fork/status")?.auth).toBe(
      "Bearer tok"
    )
  })

  it("starts the update and shows it running", async () => {
    await renderWatermark()
    fireEvent.click(screen.getByRole("button", { name: /點此更新/ }))
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }))
    await act(async () => {})

    expect(calls).toContainEqual({
      url: "/__fork/update",
      method: "POST",
      auth: "Bearer tok",
    })
    expect(screen.getByText("正在更新 fork 網頁")).toBeInTheDocument()
    expect(screen.getByText("rebasing ...")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "立即更新" })
    ).not.toBeInTheDocument()
  })

  it("asks for a reload once the new build is deployed", async () => {
    status = { ...status, built: SERVER, commit: "def5678" }
    await renderWatermark()
    expect(
      screen.getByRole("button", {
        name: "dev fork 0.32.3 已部署 · 點此重新載入",
      })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /點此重新載入/ }))
    await act(async () => {})
    expect(
      screen.getByRole("button", { name: "重新載入頁面" })
    ).toBeInTheDocument()
  })

  it("shows why the last update failed and offers a retry", async () => {
    status = {
      ...status,
      updater: {
        state: "failed",
        elapsed: null,
        log: ["rebase stopped on a conflict."],
      },
    }
    await renderWatermark()
    fireEvent.click(screen.getByRole("button", { name: /更新失敗/ }))
    await act(async () => {})
    expect(screen.getByText("更新沒有完成")).toBeInTheDocument()
    expect(
      screen.getByText("rebase stopped on a conflict.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重試" })).toBeInTheDocument()
  })

  it("says so when the update service is not reachable", async () => {
    statusCode = 502
    await renderWatermark()
    fireEvent.click(screen.getByRole("button", { name: /點此更新/ }))
    await act(async () => {})
    expect(screen.getByRole("alert")).toHaveTextContent("連不上更新服務。")
  })
})
