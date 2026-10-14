// 以 codeg 自己的介面字串把關轉換品質：zh-CN.json 是簡體原文，zh-TW.json 是
// 人工在地化的臺灣繁體（約 5,900 條，程式與介面用語）。
//
// - 分數：轉 zh-CN 的結果跟 zh-TW 完全一致的比例、字元錯誤率（CER）。門檻
//   是調好規則時的分數，改規則不能讓它變差。OpenCC 原本的 s2twp 是 60.6%／
//   9.87%。介面字串偏正式，所以日常寫法的分數本來就低一些。
// - 繁體原樣：zh-TW 的字串交給轉換器，一個字都不能變（zh-TW.json 裡還沒
//   翻譯、仍是簡體的少數字串除外）。
// - 不留簡體、轉兩次跟轉一次一樣。
//
// 規則的依據（./rules.ts 旁註的「語料 採用／保留」）也是用這份語料算的。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import * as dicts from "../opencc/dicts"
import { createEngine, type ZhTwStyle } from "./engine"

const engine = createEngine(dicts)

function strings(locale: string): Record<string, string> {
  const file = join(process.cwd(), "src/i18n/messages", `${locale}.json`)
  const out: Record<string, string> = {}
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object")
        walk(value as Record<string, unknown>, `${prefix}${key}.`)
      else if (typeof value === "string") out[prefix + key] = value
    }
  }
  walk(JSON.parse(readFileSync(file, "utf8")), "")
  return out
}

const cn = strings("zh-CN")
const tw = strings("zh-TW")
const keys = Object.keys(cn).filter(
  (k) => k in tw && /\p{Script=Han}/u.test(cn[k])
)

function distance(a: string, b: string): number {
  const A = Array.from(a)
  const B = Array.from(b)
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)
      )
    }
    prev = cur
  }
  return prev[B.length]
}

function score(style: ZhTwStyle) {
  let exact = 0
  let edits = 0
  let chars = 0
  for (const key of keys) {
    const out = engine.convert(cn[key], { style, assumeSimplified: true })
    if (out === tw[key]) exact++
    edits += distance(out, tw[key])
    chars += Array.from(tw[key]).length
  }
  return { exact: exact / keys.length, cer: edits / chars }
}

describe("zh-tw engine on codeg's own strings", () => {
  it("matches the human Taiwan localization at least as well as when the rules were tuned", () => {
    const everyday = score("everyday")
    const formal = score("formal")
    expect(everyday.exact).toBeGreaterThanOrEqual(0.64)
    expect(everyday.cer).toBeLessThanOrEqual(0.0905)
    expect(formal.exact).toBeGreaterThanOrEqual(0.65)
    expect(formal.cer).toBeLessThanOrEqual(0.0865)
  }, 60_000)

  it("leaves Traditional text exactly as written", () => {
    const changed = keys
      .filter((key) => !engine.hasSimplified(tw[key]))
      .filter((key) => engine.convert(tw[key]) !== tw[key])
      .map((key) => `${tw[key]} → ${engine.convert(tw[key])}`)
    expect(changed).toEqual([])
  })

  it("leaves no Simplified characters behind, and converting again changes nothing", () => {
    const leftovers: string[] = []
    const unstable: string[] = []
    for (const key of keys) {
      const out = engine.convert(cn[key], { assumeSimplified: true })
      if (engine.hasSimplified(out)) leftovers.push(out)
      if (engine.convert(out) !== out) unstable.push(out)
    }
    expect(leftovers).toEqual([])
    expect(unstable).toEqual([])
  })
})
