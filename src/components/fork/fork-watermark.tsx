"use client"

// 只存在於 mobile fork 的小水印，標示這個頁面是 fork 建置的 dev 版本，
// 以便和官方網頁區分。不送上游。
//
// 版本字串（上游 tag · fork commit）由 scripts/fork/deploy-web.sh 在建置時
// 透過 NEXT_PUBLIC_CODEG_FORK_TAG / NEXT_PUBLIC_CODEG_FORK_COMMIT 注入。
// 頁面會向同一個後端查詢伺服器版本（/api/health）：伺服器已經線上更新、
// 而 fork 網頁還沒重建時，水印改成琥珀色，並且可以點開，直接觸發重建
// （/__fork/，見 scripts/fork/fork_admin.py），也能看到進度與失敗原因。
//
// 位置：放在底部安全區域（iPhone 的 home indicator 那條空白帶）裡，
// 不壓到 composer；沒有安全區域的裝置則貼齊最底部。平常不接收點擊，
// 也不讓螢幕閱讀器讀到；只有落後時才是一個按鈕。
import { useCallback, useEffect, useState } from "react"
import { useLocale } from "next-intl"
import {
  CircleCheck,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const TAG = process.env.NEXT_PUBLIC_CODEG_FORK_TAG
const COMMIT = process.env.NEXT_PUBLIC_CODEG_FORK_COMMIT
const RECHECK_MS = 5 * 60 * 1000
const POLL_MS = 3000

interface ForkStatus {
  server: string
  built: string | null
  commit: string | null
  updater: {
    state: "idle" | "running" | "failed"
    elapsed: number | null
    log: string[]
  }
}

type Phase = "available" | "running" | "ready" | "failed"
type RequestError = "unauthorized" | "unreachable"

// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-TW": {
    label: { available: "點此更新", running: "更新中…", failed: "更新失敗" },
    labelReady: (v: string) => `dev fork ${v} 已部署 · 點此重新載入`,
    title: {
      available: "fork 網頁有新版本",
      running: "正在更新 fork 網頁",
      ready: "fork 網頁已更新",
      failed: "更新沒有完成",
    },
    available:
      "伺服器已經更新，這個頁面還是舊版。更新會把 fork 移到伺服器的版本上重新建置，大約 3 分鐘，期間頁面照常可用。",
    running: (elapsed: string | null) =>
      `${elapsed ? `已進行 ${elapsed}，` : ""}通常約 3 分鐘。完成後這裡會提示重新載入。`,
    ready: "新版本已經部署，重新載入頁面後生效。",
    failed: "rebase 衝突或建置失敗需要在主機上處理；其他原因可以直接重試。",
    server: "伺服器",
    page: "這個頁面",
    deployed: "已部署",
    update: "立即更新",
    retry: "重試",
    reload: "重新載入頁面",
    error: {
      unauthorized: "登入狀態已失效，無法更新。",
      unreachable: "連不上更新服務。",
    },
  },
  "zh-CN": {
    label: { available: "点此更新", running: "更新中…", failed: "更新失败" },
    labelReady: (v: string) => `dev fork ${v} 已部署 · 点此重新加载`,
    title: {
      available: "fork 网页有新版本",
      running: "正在更新 fork 网页",
      ready: "fork 网页已更新",
      failed: "更新没有完成",
    },
    available:
      "服务器已经更新，这个页面还是旧版。更新会把 fork 移到服务器的版本上重新构建，大约 3 分钟，期间页面照常可用。",
    running: (elapsed: string | null) =>
      `${elapsed ? `已进行 ${elapsed}，` : ""}通常约 3 分钟。完成后这里会提示重新加载。`,
    ready: "新版本已经部署，重新加载页面后生效。",
    failed: "rebase 冲突或构建失败需要在主机上处理；其他原因可以直接重试。",
    server: "服务器",
    page: "这个页面",
    deployed: "已部署",
    update: "立即更新",
    retry: "重试",
    reload: "重新加载页面",
    error: {
      unauthorized: "登录状态已失效，无法更新。",
      unreachable: "连不上更新服务。",
    },
  },
  en: {
    label: {
      available: "tap to update",
      running: "updating…",
      failed: "update failed",
    },
    labelReady: (v: string) => `dev fork ${v} deployed · tap to reload`,
    title: {
      available: "A newer fork build is available",
      running: "Updating the fork web",
      ready: "Fork web updated",
      failed: "The update did not finish",
    },
    available:
      "The server has updated; this page is still the old build. Updating moves the fork onto the server's release and rebuilds it — about 3 minutes, and the page keeps working meanwhile.",
    running: (elapsed: string | null) =>
      `${elapsed ? `Running for ${elapsed}; ` : ""}usually about 3 minutes. You'll be asked to reload when it's done.`,
    ready: "The new build is deployed. Reload the page to use it.",
    failed:
      "A rebase conflict or a failed build needs fixing on the host; anything else can simply be retried.",
    server: "Server",
    page: "This page",
    deployed: "Deployed",
    update: "Update now",
    retry: "Retry",
    reload: "Reload page",
    error: {
      unauthorized: "Your session has expired; can't update.",
      unreachable: "Can't reach the update service.",
    },
  },
} as const

function useCopy() {
  const locale = useLocale()
  return locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("codeg_token") ?? ""
  return { Authorization: `Bearer ${token}` }
}

class ForkRequestError extends Error {
  kind: RequestError

  constructor(kind: RequestError) {
    super(kind)
    this.kind = kind
  }
}

async function forkRequest(action: "status" | "update"): Promise<ForkStatus> {
  let res: Response
  try {
    res = await fetch(`/__fork/${action}`, {
      method: action === "update" ? "POST" : "GET",
      headers: authHeaders(),
      cache: "no-store",
    })
  } catch {
    throw new ForkRequestError("unreachable")
  }
  if (res.status === 401) throw new ForkRequestError("unauthorized")
  // 沒有接上更新服務時，nginx 會把 /__fork/ 當成頁面路由回 index.html。
  const isJson = res.headers.get("content-type")?.includes("application/json")
  if (!res.ok || !isJson) throw new ForkRequestError("unreachable")
  return (await res.json()) as ForkStatus
}

function useServerVersion() {
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch("/api/health", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
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

  return serverVersion
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

function WatermarkBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1px,calc(env(safe-area-inset-bottom)-13px))] z-[2147483647] flex justify-center select-none">
      {children}
    </div>
  )
}

export function ForkWatermark() {
  const serverVersion = useServerVersion()

  if (TAG && serverVersion && serverVersion !== TAG) {
    return <ForkUpdatePrompt server={serverVersion} />
  }

  return (
    <WatermarkBar>
      <span
        aria-hidden
        className="font-mono text-[10px] leading-none tracking-wide text-foreground/30"
      >
        {`dev fork${TAG ? ` · ${TAG}` : ""}${COMMIT ? ` · ${COMMIT}` : ""}`}
      </span>
    </WatermarkBar>
  )
}

function ForkUpdatePrompt({ server }: { server: string }) {
  const copy = useCopy()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ForkStatus | null>(null)
  const [error, setError] = useState<RequestError | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [fetchedAt, setFetchedAt] = useState(0)
  const [now, setNow] = useState(0)

  const accept = useCallback((next: ForkStatus) => {
    setStatus(next)
    setError(null)
    setFetchedAt(Date.now())
  }, [])
  const reject = useCallback((e: unknown) => {
    setError(e instanceof ForkRequestError ? e.kind : "unreachable")
  }, [])

  // 一落後就先查一次（定時器可能已經在更新了），之後每次打開再查。
  useEffect(() => {
    let cancelled = false
    forkRequest("status").then(
      (next) => {
        if (!cancelled) accept(next)
      },
      (e: unknown) => {
        if (!cancelled) reject(e)
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, accept, reject])

  const state = status?.updater.state
  // 更新進行中持續輪詢，即使彈窗關著，水印也會在完成時變成「重新載入」。
  useEffect(() => {
    if (state !== "running") return
    const id = window.setTimeout(() => {
      forkRequest("status").then(accept, reject)
    }, POLL_MS)
    return () => window.clearTimeout(id)
  }, [state, status, accept, reject])

  // 彈窗開著時，已進行時間每秒走一次。
  useEffect(() => {
    if (!open || state !== "running") return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [open, state])

  const update = () => {
    setRequesting(true)
    forkRequest("update")
      .then(accept, reject)
      .finally(() => setRequesting(false))
  }

  const target = status?.server ?? server
  const phase: Phase =
    requesting || state === "running"
      ? "running"
      : status && status.built === status.server
        ? "ready"
        : state === "failed"
          ? "failed"
          : "available"

  const elapsed =
    status?.updater.elapsed != null
      ? formatElapsed(
          status.updater.elapsed +
            Math.max(0, Math.round((now - fetchedAt) / 1000))
        )
      : null
  const log = status?.updater.log ?? []

  const label =
    phase === "ready"
      ? copy.labelReady(target)
      : `dev fork ${TAG} → ${target} · ${copy.label[phase]}`

  const Icon = {
    available: RefreshCw,
    running: Loader2,
    ready: CircleCheck,
    failed: TriangleAlert,
  }[phase]

  return (
    <WatermarkBar>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* 上下各多 8px 的點擊範圍，字的位置不變 */}
          <button
            type="button"
            className="pointer-events-auto -my-2 rounded-md px-2 py-2 font-mono text-[10px] leading-none tracking-wide text-amber-600/90 underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-amber-400/90"
          >
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" collisionPadding={8} className="gap-3">
          <div className="flex items-start gap-2.5">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                phase === "running" && "animate-spin text-muted-foreground",
                phase === "available" && "text-amber-600 dark:text-amber-400",
                phase === "ready" && "text-emerald-600 dark:text-emerald-400",
                phase === "failed" && "text-destructive"
              )}
            />
            <div className="min-w-0 space-y-1">
              <p className="leading-tight font-medium">{copy.title[phase]}</p>
              <p className="text-xs leading-snug text-muted-foreground">
                {phase === "running" ? copy.running(elapsed) : copy[phase]}
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/50 px-3 py-2 font-mono text-2xs tabular-nums">
            <dt className="text-muted-foreground">{copy.server}</dt>
            <dd>{target}</dd>
            <dt className="text-muted-foreground">{copy.page}</dt>
            <dd>{[TAG, COMMIT].filter(Boolean).join(" · ")}</dd>
            {status?.built && status.built !== TAG ? (
              <>
                <dt className="text-muted-foreground">{copy.deployed}</dt>
                <dd>
                  {[status.built, status.commit].filter(Boolean).join(" · ")}
                </dd>
              </>
            ) : null}
          </dl>

          {phase === "running" && log.length > 0 ? (
            <p className="truncate font-mono text-2xs text-muted-foreground">
              {log[log.length - 1]}
            </p>
          ) : null}
          {phase === "failed" && log.length > 0 ? (
            <pre className="max-h-32 overflow-auto rounded-lg bg-muted/50 px-3 py-2 font-mono text-2xs leading-snug break-all whitespace-pre-wrap text-muted-foreground">
              {log.join("\n")}
            </pre>
          ) : null}

          {phase === "ready" ? (
            <Button
              size="sm"
              className="w-full"
              onClick={() => window.location.reload()}
            >
              <RotateCcw />
              {copy.reload}
            </Button>
          ) : phase !== "running" ? (
            <Button size="sm" className="w-full" onClick={update}>
              <RefreshCw />
              {phase === "failed" ? copy.retry : copy.update}
            </Button>
          ) : null}

          {error ? (
            <p role="alert" className="text-2xs text-destructive">
              {copy.error[error]}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </WatermarkBar>
  )
}
