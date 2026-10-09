// mobile fork：在元件裡取得單價表。第一個用到的元件觸發載入，之後所有元件
// 共用同一份；載入失敗時下一個掛上的元件再試一次。
import { useSyncExternalStore } from "react"
import { loadPriceTable, type PriceTable } from "./pricing"

let table: PriceTable | null = null
let loading = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!table && !loading) {
    loading = true
    loadPriceTable()
      .then((loaded) => {
        table = loaded
        for (const l of listeners) l()
      })
      .catch(() => {})
      .finally(() => {
        loading = false
      })
  }
  return () => {
    listeners.delete(listener)
  }
}

/** 還沒載入好時為 null */
export function usePriceTable(): PriceTable | null {
  return useSyncExternalStore(
    subscribe,
    () => table,
    () => null
  )
}
