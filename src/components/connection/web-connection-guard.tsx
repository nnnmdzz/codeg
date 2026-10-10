"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  reconnectWebNow,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"
import { redirectToCodegLogin } from "@/lib/transport/web-auth"
import { probeTransportLiveness } from "@/lib/platform"

// Debounce before the "reconnecting" dialog is shown. Server restarts, brief
// network blips, and laptop sleep/wake usually recover within a few seconds —
// surfacing a modal for every transient drop would flicker. The transport's
// state machine flips to "reconnecting" instantly; this delay is purely the
// UI deciding when the interruption is worth interrupting the user over.
// `unauthorized` bypasses this — a rejected token is a definitive signal worth
// telling the user about immediately.
const RECONNECT_DIALOG_GRACE_MS = 4_000

/**
 * Global, single-instance guard mounted once at the root layout. Watches the
 * web transport's connection health. A lost link shows a small non-blocking
 * pill (auto-reconnecting, with a manual "Reconnect now") that leaves the
 * page usable; an expired session shows a blocking dialog (prompting
 * re-login). Both are inert outside web mode — the store returns "connected"
 * for SSR / desktop / remote-desktop, so they render nothing there. The
 * wake-time liveness probe below is not: it goes through whichever transport
 * is active, so a remote-workspace desktop window gets the same post-sleep
 * recovery via its Rust-side proxy.
 */
export function WebConnectionGuard() {
  const t = useTranslations("WebConnection")
  const state = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )

  // Grace debounce: only reveal the reconnecting dialog once the link has been
  // down continuously for RECONNECT_DIALOG_GRACE_MS. `graceElapsed` is set
  // true only from the timer callback; the cleanup resets it to false whenever
  // `state` changes (recovered, or escalated to unauthorized), so the next
  // outage starts a fresh grace window rather than flashing instantly.
  const [graceElapsed, setGraceElapsed] = useState(false)
  useEffect(() => {
    if (state !== "reconnecting") return
    const id = setTimeout(
      () => setGraceElapsed(true),
      RECONNECT_DIALOG_GRACE_MS
    )
    return () => {
      clearTimeout(id)
      setGraceElapsed(false)
    }
  }, [state])

  // Fast recovery on network restore / tab wake. Two things can be wrong when
  // the machine wakes. Either the transport already knows the link is down —
  // backoff caps at 32s, so probe right away instead of waiting it out — or
  // it does NOT know: a socket that died during sleep sits in OPEN state
  // until the OS times it out, with no close event to trigger reconnection,
  // and the event stream stays dark for minutes. `probeTransportLiveness`
  // covers both — while reconnecting it skips the remaining backoff; on a
  // seemingly-healthy socket it pings and replaces the socket if no pong
  // comes back within seconds. A healthy link only ever costs one ping.
  // `pageshow` is the bfcache restore on mobile Safari, which fires no
  // `visibilitychange`. Inert on the local desktop transport, whose IPC has
  // no socket to lose.
  useEffect(() => {
    const probe = () => probeTransportLiveness()
    const onVisible = () => {
      if (document.visibilityState === "visible") probe()
    }
    window.addEventListener("online", probe)
    window.addEventListener("pageshow", probe)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", probe)
      window.removeEventListener("pageshow", probe)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  const showReconnecting = state === "reconnecting" && graceElapsed
  const showUnauthorized = state === "unauthorized"

  // 重連中：改用不攔截操作的小膠囊，放在標題列下方。斷線時已載入的紀錄
  // 仍可上下捲動翻看，只有按鈕本身接收點擊，其餘區域點擊與捲動都穿透。
  if (showReconnecting) {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3rem)] z-50 flex justify-center px-4">
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex items-center gap-2 rounded-full border bg-popover/95 py-1 pr-1 pl-3 text-xs text-popover-foreground shadow-sm backdrop-blur"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <span>{t("disconnectedTitle")}</span>
          <span className="sr-only">{t("reconnectingDescription")}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 rounded-full px-2 text-xs"
            onClick={() => reconnectWebNow()}
          >
            {t("reconnectNow")}
          </Button>
        </div>
      </div>
    )
  }

  if (!showUnauthorized) return null

  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent
        // Forced state: block Esc/outside dismissal. The dialog is driven
        // entirely by connection health — it closes when the session is
        // restored, not on user whim.
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ShieldAlert className="text-destructive" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("sessionExpiredTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("sessionExpiredDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={() => redirectToCodegLogin()}>
            {t("goToLogin")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
