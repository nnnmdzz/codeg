import { describe, expect, it } from "vitest"
import { loadS2TWP } from "./s2twp"

// 期望值由官方 opencc-js@1.4.2 的 Converter({ from: "cn", to: "twp" })
// 產生；搬進來的版本另以七萬多筆輸入逐筆比對過，結果完全相同。
const CASES: [string, string][] = [
  [
    "这个服务器的数据库连接池默认配置有问题，请帮我检查一下代码里的缓存逻辑。",
    "這個伺服器的資料庫連線池預設配置有問題，請幫我檢查一下程式碼裡的快取邏輯。",
  ],
  [
    "把软件更新到最新版本后，视频和U盘里的文件都打不开了。",
    "把軟體更新到最新版本後，影片和U盤裡的檔案都打不開了。",
  ],
  [
    "我们的项目用的是 React 和 TypeScript，界面要支持移动端。",
    "我們的專案用的是 React 和 TypeScript，介面要支援移動端。",
  ],
  // 已是繁體、英文、符號：原樣不動
  ["已經是繁體的句子。", "已經是繁體的句子。"],
  ["pnpm test --run 2>&1 | tail", "pnpm test --run 2>&1 | tail"],
]

describe("loadS2TWP", () => {
  it("converts Simplified Chinese to Traditional with Taiwan phrasing", async () => {
    const convert = await loadS2TWP()
    for (const [input, expected] of CASES) {
      expect(convert(input)).toBe(expected)
    }
  })

  it("loads the dictionaries once and reuses the converter", async () => {
    expect(await loadS2TWP()).toBe(await loadS2TWP())
  })
})
