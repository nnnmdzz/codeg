// mobile fork：「傳送前自動轉為繁體」開關。
//
// 存在這台裝置的 localStorage，預設關閉。同一頁裡的每個輸入框、其他分頁
// （storage 事件）都即時跟著變。
import { useSyncExternalStore } from "react"

const KEY = "codeg_fork_convert_on_send"
const listeners = new Set<() => void>()
let current: boolean | null = null

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function getConvertOnSend(): boolean {
  current ??= read()
  return current
}

export function setConvertOnSend(on: boolean) {
  current = on
  try {
    if (on) localStorage.setItem(KEY, "1")
    else localStorage.removeItem(KEY)
  } catch {
    // 存不了（隱私模式等）就只在這次開啟期間有效
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return
    current = read()
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function useConvertOnSend(): boolean {
  return useSyncExternalStore(subscribe, getConvertOnSend, () => false)
}

/** 測試用：忘掉讀過的值，下次重新讀 localStorage */
export function resetConvertOnSendCache() {
  current = null
}
