// 只存在於 mobile fork 的小水印，標示這個頁面是 fork 建置的 dev 版本，
// 以便和官方網頁區分。不送上游。
//
// 版本字串（上游 tag · fork commit）由 scripts/fork/deploy-web.sh 在建置時
// 透過 NEXT_PUBLIC_CODEG_FORK_BUILD 注入；沒有經過腳本建置時只顯示「dev fork」。
// 不接收任何點擊（pointer-events: none），也不讓螢幕閱讀器讀到。
const BUILD = process.env.NEXT_PUBLIC_CODEG_FORK_BUILD

export function ForkWatermark() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+2px)] z-[2147483647] flex justify-center select-none"
    >
      <span className="font-mono text-[10px] leading-none tracking-wide text-foreground/25">
        dev fork{BUILD ? ` · ${BUILD}` : ""}
      </span>
    </div>
  )
}
