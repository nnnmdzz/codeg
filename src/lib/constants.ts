export const CONNECTION_IDLE_TIMEOUT_MS = 1 * 60 * 1000 // 1 minute
export const IDLE_SWEEP_INTERVAL_MS = 60 * 1000 // 1 minute
// Keepalive cadence for backend idle-sweep protection. Must be tighter
// than the backend's CODEG_ACP_IDLE_TIMEOUT_SECS (default 180s) so each
// open tab gets at least one touch per backend timeout window — 30s
// gives ample safety margin under network jitter.
// mobile fork：改為 90 秒。仍小於後端預設的 180 秒閒置時限，留有一倍餘量，
// 開著的會話每分鐘少兩個請求。後端的 CODEG_ACP_IDLE_TIMEOUT_SECS 若調低到
// 180 秒以下，這裡要跟著調小。
export const CONNECTION_KEEPALIVE_INTERVAL_MS = 90 * 1000 // 90 seconds
