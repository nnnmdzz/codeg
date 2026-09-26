// mobile fork：記錄「這台裝置上的哪個頁面建立了哪條 agent 連線」。
//
// 伺服器不記錄連線是哪個用戶端開的（網頁一律標成 "web"），所以跨裝置無從
// 分辨；但同一台裝置上，localStorage 是各頁面共用的，足以回答兩件事：
//
// 1. 以 viewer 身分接入時，這條連線是本裝置開的，還是其他裝置或瀏覽器開的。
// 2. 本裝置開的、而原本的頁面已經不在了（重新載入、app 從背景回來 WebView
//    被回收重建）——這時可以直接以 owner 身分接手，不必當 viewer。
//
// 「頁面還在不在」靠心跳判斷：每個頁面定期把自己的時間戳寫進 localStorage，
// 關閉（pagehide）時移除。被系統凍結的背景分頁不會更新心跳，會被當成已不在；
// 為此另有一道保險：連線被別的頁面接手後，原頁面不會再對它呼叫 acpDisconnect
// （見 `isClaimedByAnotherPage`），以免把接手者正在用的 agent 關掉。

const CONNECTIONS_KEY = "codeg_fork_owned_connections"
const PAGES_KEY = "codeg_fork_live_pages"
const HEARTBEAT_MS = 10_000
// 超過這麼久沒有心跳，就當作那個頁面已經不在了。
const PAGE_STALE_MS = 30_000
// 紀錄只是提示用，保留一段時間即可；伺服器的閒置連線幾分鐘內就會被清掉。
const ENTRY_TTL_MS = 3 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 100

export interface OwnedConnection {
  createdAt: number
  pageId: string
}

type ConnectionMap = Record<string, OwnedConnection>
type PageMap = Record<string, number>

function newPageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// 每次載入頁面都是新的 id；重新載入後就是「另一個頁面」。
const PAGE_ID = typeof window === "undefined" ? "ssr" : newPageId()

function read<T extends object>(key: string): T {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === "object" ? (parsed as T) : ({} as T)
  } catch {
    return {} as T
  }
}

function write(key: string, value: object) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 配額滿或無痕模式：這只是輔助資訊，寫不進去就算了。
  }
}

function isPageAlive(pageId: string, now = Date.now()): boolean {
  if (pageId === PAGE_ID) return true
  const seen = read<PageMap>(PAGES_KEY)[pageId]
  return typeof seen === "number" && now - seen < PAGE_STALE_MS
}

function beat() {
  const now = Date.now()
  const pages = read<PageMap>(PAGES_KEY)
  pages[PAGE_ID] = now
  for (const [id, seen] of Object.entries(pages)) {
    if (now - seen >= PAGE_STALE_MS) delete pages[id]
  }
  write(PAGES_KEY, pages)
}

let heartbeatStarted = false

function ensureHeartbeat() {
  if (heartbeatStarted || typeof window === "undefined") return
  heartbeatStarted = true
  beat()
  window.setInterval(beat, HEARTBEAT_MS)
  // 頁面關閉或重新載入時立刻讓出，下一個頁面不必等心跳過期就能接手。
  window.addEventListener("pagehide", () => {
    const pages = read<PageMap>(PAGES_KEY)
    delete pages[PAGE_ID]
    write(PAGES_KEY, pages)
  })
  // 從 bfcache 回來，或背景分頁恢復執行時，馬上補一次心跳。
  window.addEventListener("pageshow", beat)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat()
  })
}

function save(connectionId: string) {
  const now = Date.now()
  const entries = read<ConnectionMap>(CONNECTIONS_KEY)
  entries[connectionId] = { createdAt: now, pageId: PAGE_ID }
  const kept = Object.entries(entries)
    .filter(([, e]) => now - e.createdAt < ENTRY_TTL_MS)
    .sort(([, a], [, b]) => b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)
  write(CONNECTIONS_KEY, Object.fromEntries(kept))
}

/** 這個頁面剛以 owner 身分建立（或重用）了一條連線。 */
export function recordOwnedConnection(connectionId: string) {
  if (typeof window === "undefined") return
  ensureHeartbeat()
  save(connectionId)
}

/** 這條連線是否由這台裝置上的頁面建立；不是則回傳 null。 */
export function ownedConnectionInfo(
  connectionId: string
): OwnedConnection | null {
  if (typeof window === "undefined") return null
  return read<ConnectionMap>(CONNECTIONS_KEY)[connectionId] ?? null
}

/**
 * 能否以 owner 身分接手這條連線：必須是本裝置建立的，而且建立它的頁面
 * 已經不在（或就是目前這個頁面，只是已不在它的連線清單裡）。
 */
export function canClaimOwnedConnection(connectionId: string): boolean {
  const info = ownedConnectionInfo(connectionId)
  if (!info) return false
  ensureHeartbeat()
  return info.pageId === PAGE_ID || !isPageAlive(info.pageId)
}

/** 接手：把這條連線記到目前頁面名下。 */
export function claimOwnedConnection(connectionId: string) {
  recordOwnedConnection(connectionId)
}

/**
 * 這條連線已被本裝置的另一個頁面接手。原頁面（例如被凍結後又醒來的背景
 * 分頁）此時不可再 acpDisconnect 它，否則會關掉接手者正在用的 agent。
 */
export function isClaimedByAnotherPage(connectionId: string): boolean {
  const info = ownedConnectionInfo(connectionId)
  return info != null && info.pageId !== PAGE_ID
}
