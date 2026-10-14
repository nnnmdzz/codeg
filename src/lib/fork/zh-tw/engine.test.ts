import { describe, expect, it } from "vitest"

import * as dicts from "../opencc/dicts"
import { createEngine, type ConvertOptions } from "./engine"

const engine = createEngine(dicts)
const convert = (text: string, options?: ConvertOptions) =>
  engine.convert(text, options)
/** 可點選的段落：原文 → 選項 */
const choices = (text: string, options?: ConvertOptions) =>
  engine
    .pieces(text, options)
    .filter((p) => p.options)
    .map((p) => [p.source, p.options])

describe("zh-tw engine", () => {
  it("fixes the mistakes OpenCC made in real messages", () => {
    // OpenCC 的 s2twp 曾經轉成：許可權、好多工失敗、認證型別、這臺
    expect(convert("你需要什么权限我给你")).toBe("你需要什麼權限我給你")
    expect(convert("app有好多任务失败的通知，特别难看")).toBe(
      "app有好多任務失敗的通知，特別難看"
    )
    expect(convert("可以只处理官网订阅的认证类型")).toBe(
      "可以只處理官網訂閱的認證類型"
    )
    expect(convert("我的这台服务器")).toBe("我的這台伺服器")
  })

  it("never rewrites text that is already Traditional", () => {
    for (const text of [
      "這個項目很重要，請把權限給我",
      "干擾和若干問題",
      "我們在台灣，這台伺服器",
      "支持你的決定，文件放在桌面",
      "皇后住在後宮",
    ]) {
      expect(convert(text)).toBe(text)
      expect(convert(text, { style: "formal" })).toBe(text)
    }
  })

  it("converts only the Simplified part of a mixed clause", () => {
    expect(convert("這個项目的代码有问题")).toBe("這個專案的程式碼有問題")
    // 「干」緊鄰繁體的「擾」，是繁體的詞，不動
    expect(convert("這個项目的干擾")).toBe("這個專案的干擾")
  })

  it("converts words written alike in both scripts only when the draft is Simplified", () => {
    expect(convert("保存")).toBe("保存")
    expect(convert("保存", { assumeSimplified: true })).toBe("儲存")
    expect(convert("刷新", { assumeSimplified: true })).toBe("重新整理")
    expect(engine.leansSimplified("这是简体，有几个字")).toBe(true)
    expect(engine.leansSimplified("這是繁體，有幾個字")).toBe(false)
  })

  it("uses Taiwan's words where they are settled", () => {
    expect(convert("这个函数的参数类型不对，抛出异常了")).toBe(
      "這個函式的參數型別不對，拋出例外了"
    )
    expect(convert("用户反馈说请求超时，返回值是空的")).toBe(
      "使用者回饋說請求逾時，回傳值是空的"
    )
    expect(convert("这个项目的代码质量还可以")).toBe(
      "這個專案的程式碼品質還可以"
    )
    expect(convert("把默认配置改成从环境变量读取，然后重启服务器")).toBe(
      "把預設設定改成從環境變數讀取，然後重新啟動伺服器"
    )
    expect(convert("这个账号的自定义设置")).toBe("這個帳號的自訂設定")
    expect(convert("后台运行的程序")).toBe("背景執行的程式")
    expect(convert("在终端里运行")).toBe("在終端機裡執行")
  })

  it("uses Taiwan's everyday words (Taiwan.md and a few common ones)", () => {
    expect(convert("我们坐地铁去公司，下了地铁再转公交车")).toBe(
      "我們坐捷運去公司，下了捷運再轉公車"
    )
    // 講外地的地鐵系統，臺灣也說「地鐵」
    expect(convert("东京地铁比北京地铁复杂")).toBe("東京地鐵比北京地鐵複雜")
    expect(convert("打车回家太贵了，还是坐出租车吧")).toBe(
      "叫車回家太貴了，還是坐計程車吧"
    )
    expect(convert("晚饭吃土豆炒肉和西红柿炒蛋，饭后来点菠萝和猕猴桃")).toBe(
      "晚飯吃馬鈴薯炒肉和番茄炒蛋，飯後來點鳳梨和奇異果"
    )
    expect(convert("办公室的空调太冷了，充电宝也没电了")).toBe(
      "辦公室的冷氣太冷了，行動電源也沒電了"
    )
    expect(convert("他发了一个帖子，很多人点赞")).toBe(
      "他發了一個貼文，很多人按讚"
    )
    expect(convert("他骑自行车上班，我骑摩托车")).toBe(
      "他騎腳踏車上班，我騎機車"
    )
    // 程式語境的「打包」「推送」不是外帶、推播
    expect(convert("打包以后推送到远程仓库")).toBe("打包以後推送到遠端倉庫")
  })

  it("recognizes Simplified from words whose Traditional form is another character", () => {
    // 沒有簡體專用字，但「方便面」的「面」在繁體寫成「麵」
    expect(convert("早上喝一杯酸奶，吃一包方便面")).toBe(
      "早上喝一杯優酪乳，吃一包泡麵"
    )
    // 了解／瞭解、占用／佔用 是臺灣兩種都寫的異體：繁體的原文不動
    for (const text of ["了解詳情", "快捷鍵已被占用", "用量分布", "目前回合"]) {
      expect(convert(text)).toBe(text)
    }
  })

  it("recognizes characters Taiwan never writes on their own", () => {
    // OpenCC 只在 草荐、荐臻、万俟 這類古語、專名裡保留這些字，臺灣平常寫
    // 推薦、一萬、確定、別管：單獨出現或混在繁體裡，都是簡體
    expect(convert("推荐")).toBe("推薦")
    expect(convert("推荐一下")).toBe("推薦一下")
    expect(convert("推荐給你")).toBe("推薦給你")
    expect(convert("這個推荐很好")).toBe("這個推薦很好")
    expect(convert("确定")).toBe("確定")
    expect(convert("别管了")).toBe("別管了")
    expect(convert("一万")).toBe("一萬")
    expect(engine.leansSimplified("推荐")).toBe(true)
    // 保留它的詞照舊不動
    expect(convert("草荐")).toBe("草荐")
    expect(convert("荐居")).toBe("荐居")
  })

  it("keeps the general sense where the computing word would be wrong", () => {
    expect(convert("我们支持你的决定")).toBe("我們支持你的決定")
    expect(convert("这个软件支持移动端")).toBe("這個軟體支援行動裝置")
    expect(convert("请提交官方文件")).toBe("請提交官方文件")
    expect(convert("帮我保存文件")).toBe("幫我儲存檔案")
    expect(convert("这是法律程序")).toBe("這是法律程序")
    // 「通过」在句尾是「通過」，後面接動作才是「透過」
    expect(convert("3 项测试通过")).toBe("3 項測試通過")
    expect(convert("{count} 项通过")).toBe("{count} 項通過")
    expect(convert("通过环境变量传入")).toBe("透過環境變數傳入")
    // LLM 的 token 數不是驗證用的權杖
    expect(convert("令牌统计")).toBe("令牌統計")
    expect(convert("访问令牌过期了")).toBe("存取權杖過期了")
  })

  it("does not let an added word cut through another word", () => {
    expect(convert("合并发送")).toBe("合併發送")
    expect(convert("国家安全局")).toBe("國家安全局")
    expect(convert("交通过度拥堵")).toBe("交通過度擁堵")
    expect(convert("打开终端机")).toBe("打開終端機")
    expect(convert("这个工作流程")).toBe("這個工作流程")
    expect(convert("响应式布局")).toBe("響應式佈局")
  })

  it("resolves characters with several Traditional forms", () => {
    expect(convert("他头发很长，干部也要干实事")).toBe(
      "他頭髮很長，幹部也要幹實事"
    )
    expect(convert("台风来了，这台电脑在台湾，台积电")).toBe(
      "颱風來了，這台電腦在台灣，台積電"
    )
  })

  it("writes everyday words by default and formal ones on request", () => {
    expect(convert("优化一下，打开网站")).toBe("優化一下，打開網站")
    expect(convert("优化一下，打开网站", { style: "formal" })).toBe(
      "最佳化一下，開啟網站"
    )
    expect(
      convert("台风来了，这台电脑在台湾，台积电", { style: "formal" })
    ).toBe("颱風來了，這臺電腦在臺灣，台積電")
  })

  it("marks every decision a reader may want to change", () => {
    expect(choices("可以只处理官网订阅的认证类型")).toContainEqual([
      "类型",
      ["類型", "型別"],
    ])
    expect(choices("好多任务失败")).toContainEqual([
      "多任务",
      ["多任務", "多工"],
    ])
    expect(choices("这个项目")).toContainEqual(["项目", ["專案", "項目"]])
    expect(choices("优化一下")).toContainEqual(["优化", ["優化", "最佳化"]])
    expect(choices("发一下")).toContainEqual(["发", ["發", "髮"]])
    // 「台」只有那一個字可以點，不連著 OpenCC 切在一起的「電」
    expect(choices("这台电脑")).toEqual([["台", ["台", "臺"]]])
    // 「台積電」本來就寫「台」，沒有東西可選
    expect(choices("台积电的工厂")).toEqual([])
    // 選項一樣就不標
    expect(choices("水平扩展")).toEqual([])
  })

  it("applies the reader's choices for this draft", () => {
    const options: ConvertOptions = { choices: new Map([["项目", "項目"]]) }
    expect(convert("这个项目的代码", options)).toBe("這個項目的程式碼")
    const piece = engine
      .pieces("这个项目", options)
      .find((p) => p.source === "项目")
    expect(piece).toMatchObject({ text: "項目", chosen: true })
    // 不在選項裡的選擇不套用
    expect(convert("这个项目", { choices: new Map([["项目", "計畫"]]) })).toBe(
      "這個專案"
    )
  })

  it("puts the personal dictionary above everything else", () => {
    const personal = new Map([
      ["原生态", "道地"],
      ["项目", "項目"],
    ])
    expect(convert("这个网站很原生态", { personal })).toBe("這個網站很道地")
    expect(convert("这个项目", { personal })).toBe("這個項目")
    const piece = engine
      .pieces("很原生态", { personal })
      .find((p) => p.source === "原生态")
    expect(piece).toMatchObject({
      text: "道地",
      reason: "personal",
      options: ["道地", "原生態"],
    })
  })

  it("joins its pieces into exactly the converted text", () => {
    for (const text of [
      "这个函数的参数类型不对，抛出异常了",
      "這個项目的干擾",
      "台风来了，这台电脑在台湾，台积电",
      "app有好多任务失败的通知，特别难看",
    ]) {
      expect(
        engine
          .pieces(text)
          .map((p) => p.text)
          .join("")
      ).toBe(convert(text))
      expect(
        engine
          .pieces(text)
          .map((p) => p.source)
          .join("")
      ).toBe(text)
    }
  })
})
