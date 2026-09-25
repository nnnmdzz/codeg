"use client"

// 只存在於 mobile fork 的小水印，標示這個頁面是 fork 建置的 dev 版本，
// 以便和官方網頁區分。不送上游。
//
// 版本字串（上游 tag · fork commit）由 scripts/fork/deploy-web.sh 在建置時
// 透過 NEXT_PUBLIC_CODEG_FORK_TAG / NEXT_PUBLIC_CODEG_FORK_COMMIT 注入。
// 頁面會向同一個後端查詢伺服器版本（/api/health）：伺服器已經線上更新、
// 而 fork 網頁還沒重建時，水印改成琥珀色並寫明兩邊的版本，提醒 fork 落後。
//
// 位置：放在底部安全區域（iPhone 的 home indicator 那條空白帶）裡，
// 不壓到 composer；沒有安全區域的裝置則貼齊最底部。不接收任何點擊，
// 也不讓螢幕閱讀器讀到。
import { useEffect, useState } from "react"

const TAG = process.env.NEXT_PUBLIC_CODEG_FORK_TAG
const COMMIT = process.env.NEXT_PUBLIC_CODEG_FORK_COMMIT
const RECHECK_MS = 5 * 60 * 1000

export function ForkWatermark() {
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const token = localStorage.getItem("codeg_token") ?? ""
        const res = await fetch("/api/health", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: "{}",
        })
        if (!res.ok) return
        const body = (await res.json()) as { version?: string }
        if (!cancelled && body.version) setServerVersion(body.version)
      } catch {
        // 查不到就只顯示 fork 自己的版本
      }
    }
    void check()
    const timer = window.setInterval(check, RECHECK_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const behind = Boolean(TAG && serverVersion && serverVersion !== TAG)
  const label = behind
    ? `dev fork ${TAG} · server ${serverVersion} · 待重建`
    : `dev fork${TAG ? ` · ${TAG}` : ""}${COMMIT ? ` · ${COMMIT}` : ""}`

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-[max(1px,calc(env(safe-area-inset-bottom)-13px))] z-[2147483647] flex justify-center select-none"
    >
      <span
        className={
          behind
            ? "font-mono text-[10px] leading-none tracking-wide text-amber-600/80 dark:text-amber-400/80"
            : "font-mono text-[10px] leading-none tracking-wide text-foreground/30"
        }
      >
        {label}
      </span>
    </div>
  )
}
