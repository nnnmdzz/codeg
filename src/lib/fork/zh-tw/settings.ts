// mobile fork：繁體轉換的設定，存在這台裝置的 localStorage。同一頁裡的每個
// 輸入框、其他分頁（storage 事件）都即時跟著變。
//
// - 寫法：日常（台、優化、打開，預設）或正式（臺、最佳化、開啟）
// - 同步預覽：草稿有簡體時，在輸入框下方顯示轉換後的樣子（預設開）
// - 個人詞庫：簡體原文 → 寫法，優先於其他所有規則
// - 點選紀錄：同一個詞選了別的寫法幾次，用來提議加進個人詞庫
import { useSyncExternalStore } from "react"
import type { ZhTwStyle } from "./engine"

interface Setting<T> {
  get(): T
  set(value: T): void
  use(): T
  /** 測試用：忘掉讀過的值，下次重新讀 localStorage */
  reset(): void
}

function localSetting<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null
): Setting<T> {
  const listeners = new Set<() => void>()
  const fallback = parse(null)
  let cached: { value: T } | null = null

  const read = (): T => {
    try {
      return parse(localStorage.getItem(key))
    } catch {
      return fallback
    }
  }
  const get = () => (cached ??= { value: read() }).value
  const set = (value: T) => {
    cached = { value }
    try {
      const raw = serialize(value)
      if (raw === null) localStorage.removeItem(key)
      else localStorage.setItem(key, raw)
    } catch {
      // 存不了（隱私模式等）就只在這次開啟期間有效
    }
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return
      cached = null
      listener()
    }
    window.addEventListener("storage", onStorage)
    return () => {
      listeners.delete(listener)
      window.removeEventListener("storage", onStorage)
    }
  }
  return {
    get,
    set,
    use: () => useSyncExternalStore(subscribe, get, () => fallback),
    reset: () => {
      cached = null
    },
  }
}

export const styleSetting = localSetting<ZhTwStyle>(
  "codeg_fork_zh_tw_style",
  (raw) => (raw === "formal" ? "formal" : "everyday"),
  (value) => (value === "formal" ? "formal" : null)
)

export const previewSetting = localSetting<boolean>(
  "codeg_fork_zh_tw_preview",
  (raw) => raw !== "0",
  (value) => (value ? null : "0")
)

/** 個人詞庫。同一個 Map 會一直沿用到內容改變（引擎依此判斷要不要重建）。 */
export const personalSetting = localSetting<ReadonlyMap<string, string>>(
  "codeg_fork_zh_tw_personal",
  (raw) => {
    if (!raw) return new Map()
    try {
      const pairs = JSON.parse(raw) as unknown
      if (!Array.isArray(pairs)) return new Map()
      return new Map(
        pairs.filter(
          (p): p is [string, string] =>
            Array.isArray(p) &&
            typeof p[0] === "string" &&
            typeof p[1] === "string" &&
            p[0] !== ""
        )
      )
    } catch {
      return new Map()
    }
  },
  (value) => (value.size ? JSON.stringify([...value]) : null)
)

export function addPersonalRule(source: string, text: string) {
  const next = new Map(personalSetting.get())
  next.set(source, text)
  personalSetting.set(next)
}

export function removePersonalRule(source: string) {
  const next = new Map(personalSetting.get())
  if (next.delete(source)) personalSetting.set(next)
}

type Picks = Readonly<Record<string, Readonly<Record<string, number>>>>

const picksSetting = localSetting<Picks>(
  "codeg_fork_zh_tw_picks",
  (raw) => {
    try {
      const value = raw ? (JSON.parse(raw) as unknown) : null
      return value && typeof value === "object" ? (value as Picks) : {}
    } catch {
      return {}
    }
  },
  (value) => (Object.keys(value).length ? JSON.stringify(value) : null)
)

/** 記下「原文選了某個非預設的寫法」，回傳這是第幾次。 */
export function recordPick(source: string, text: string): number {
  const picks = picksSetting.get()
  const count = (picks[source]?.[text] ?? 0) + 1
  picksSetting.set({ ...picks, [source]: { ...picks[source], [text]: count } })
  return count
}

/** 測試用 */
export function resetZhTwSettingsCache() {
  styleSetting.reset()
  previewSetting.reset()
  personalSetting.reset()
  picksSetting.reset()
}
