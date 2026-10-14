// 引擎是照 opencc-js 的 s2twp 演算法重寫的（為了記下每段的來源與可換的
// 寫法）。規則全部清空時，結果必須跟內嵌的 opencc-js（../opencc/core.js，
// 原封不動的官方程式）逐字相同——codeg 的簡體介面字串逐筆比對。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { ConverterBuilder } from "../opencc/core"
import * as dicts from "../opencc/dicts"
import { createEngine, type ZhTwRules } from "./engine"

const NO_RULES: ZhTwRules = {
  TW_PHRASES_DROPPED: [],
  TW_PHRASES_OPTIONAL: [],
  TW_PHRASES_FORMAL: [],
  ADDED_TERMS: [],
  OPTIONAL_TERMS: [],
  NOT_AT_CLAUSE_END: [],
  GUARDS: [],
  CHAR_PREFERENCES: {},
}

const opencc = ConverterBuilder({
  from: { cn: [[dicts.STPhrases, dicts.STCharacters]] },
  to: { twp: [[dicts.TWPhrases], [dicts.TWVariantsPhrases, dicts.TWVariants]] },
  configs: {
    s2twp: {
      normalizationChain: [[dicts.CJK_Compatibility_Ideographs]],
      segmentation: [
        dicts.STPhrases,
        dicts.STPhrases_GeneratedFromRegionalPhrases,
      ],
      conversionChain: [
        [
          dicts.STPhrases,
          dicts.STPhrases_GeneratedFromRegionalPhrases,
          dicts.STCharacters,
        ],
        [dicts.TWPhrases, dicts.TWVariantsPhrases, dicts.TWVariants],
      ],
    },
  },
})({ from: "cn", to: "twp" })

function zhCnStrings(): string[] {
  const out: string[] = []
  const walk = (node: Record<string, unknown>) => {
    for (const value of Object.values(node)) {
      if (value && typeof value === "object")
        walk(value as Record<string, unknown>)
      else if (typeof value === "string") out.push(value)
    }
  }
  walk(
    JSON.parse(
      readFileSync(join(process.cwd(), "src/i18n/messages/zh-CN.json"), "utf8")
    )
  )
  return out
}

describe("zh-tw engine without its rules", () => {
  it("converts exactly like opencc-js s2twp", () => {
    const engine = createEngine(dicts, NO_RULES)
    const texts = zhCnStrings().filter(
      (t) => !engine.hasSimplified(opencc(t)) && /\p{Script=Han}/u.test(t)
    )
    const different = texts
      .filter(
        (t) =>
          engine.convert(t, { style: "formal", assumeSimplified: true }) !==
          opencc(t)
      )
      .map(
        (t) =>
          `${t}\n  engine ${engine.convert(t, { style: "formal", assumeSimplified: true })}\n  opencc ${opencc(t)}`
      )
    expect(texts.length).toBeGreaterThan(5000)
    expect(different.slice(0, 10)).toEqual([])
  }, 60_000)
})
