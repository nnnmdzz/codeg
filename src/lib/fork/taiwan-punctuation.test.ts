import { describe, expect, it } from "vitest"
import { taiwanPunctuation } from "./taiwan-punctuation"

describe("taiwanPunctuation", () => {
  it("uses corner brackets for quotes in Chinese", () => {
    expect(taiwanPunctuation("他說：“我覺得‘還好’。”")).toBe(
      "他說：「我覺得『還好』。」"
    )
    // 引號裡是英文，但用在中文句子裡
    expect(taiwanPunctuation("“OK”是吧")).toBe("「OK」是吧")
    expect(taiwanPunctuation("點“Save”按鈕")).toBe("點「Save」按鈕")
  })

  it("leaves English quotes and apostrophes alone", () => {
    expect(taiwanPunctuation("“Hello,” she said. It’s fine.")).toBe(
      "“Hello,” she said. It’s fine."
    )
    expect(taiwanPunctuation("Bob’s 報告")).toBe("Bob’s 報告")
    // 直的引號可能是指令的一部分
    expect(taiwanPunctuation('執行 git commit -m "修正"')).toBe(
      '執行 git commit -m "修正"'
    )
  })

  it("uses the Taiwanese interpunct and dash", () => {
    expect(taiwanPunctuation("列夫·托爾斯泰")).toBe("列夫‧托爾斯泰")
    expect(taiwanPunctuation("a·b、x・y")).toBe("a·b、x・y")
    expect(taiwanPunctuation("等等——然後")).toBe("等等──然後")
    expect(taiwanPunctuation("wait — then")).toBe("wait — then")
  })

  it("makes half-width punctuation after Chinese full-width", () => {
    expect(taiwanPunctuation("你好,世界.")).toBe("你好，世界。")
    expect(taiwanPunctuation("真的?好!注意:這個;那個")).toBe(
      "真的？好！注意：這個；那個"
    )
    // 後面的半形空格一併拿掉
    expect(taiwanPunctuation("好了, 然後 run.")).toBe("好了，然後 run.")
    expect(taiwanPunctuation("「好」,走吧")).toBe("「好」，走吧")
  })

  it("keeps periods that belong to file names, paths, numbers and ellipses", () => {
    for (const text of [
      "看說明.txt",
      "進入./src",
      "版本1.2",
      "然後...",
      "共3,000個",
      "時間3:30",
    ]) {
      expect(taiwanPunctuation(text)).toBe(text)
    }
  })
})
