"use client"

import { useLocale } from "next-intl"
import { ownedConnectionInfo } from "@/lib/fork/owned-connections"

// mobile fork：viewer 提示下方補一行「這條連線是誰開的」。伺服器不記來源，
// 只能靠本機紀錄分出「這台裝置的另一個頁面」與「其他裝置或瀏覽器」。
// fork 專用字串不放進 i18n/messages，避免和上游的翻譯檔衝突。
const COPY = {
  "zh-CN": {
    thisDevice: (ago: string) =>
      `由这台设备上另一个仍打开的页面建立（${ago}）。`,
    elsewhere: "由其他设备或浏览器建立。",
  },
  "zh-TW": {
    thisDevice: (ago: string) =>
      `由這台裝置上另一個仍開著的頁面建立（${ago}）。`,
    elsewhere: "由其他裝置或瀏覽器建立。",
  },
  en: {
    thisDevice: (ago: string) =>
      `Opened by another page still open on this device (${ago}).`,
    elsewhere: "Opened by another device or browser.",
  },
} as const

function relativeTime(locale: string, from: number): string {
  const minutes = Math.round((Date.now() - from) / 60_000)
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  if (minutes < 60) return fmt.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return fmt.format(-hours, "hour")
  return fmt.format(-Math.round(hours / 24), "day")
}

export function ViewerOriginNote({ connectionId }: { connectionId: string }) {
  const locale = useLocale()
  const copy = locale in COPY ? COPY[locale as keyof typeof COPY] : COPY.en
  const info = ownedConnectionInfo(connectionId)
  return (
    <p className="text-2xs leading-snug text-muted-foreground">
      {info
        ? copy.thisDevice(relativeTime(locale, info.createdAt))
        : copy.elsewhere}
    </p>
  )
}
