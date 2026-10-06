// mobile fork：簡體 → 繁體（台灣用語），即 OpenCC 的 s2twp 設定。
//
// 轉換程式與字典抽自 opencc-js（見 ./opencc/ 與
// scripts/fork/vendor-opencc.mjs）。字典約 1.1 MB，第一次轉換時才以動態
// import 載入，成為獨立的 chunk，不影響頁面平常的載入；之後重複使用同一個
// 轉換器。
import type { ConverterFunction } from "./opencc/core"

let converter: Promise<ConverterFunction> | null = null

export function loadS2TWP(): Promise<ConverterFunction> {
  converter ??= Promise.all([import("./opencc/core"), import("./opencc/dicts")])
    .then(([core, d]) => {
      // 與 opencc-js preset/cn2t.js 的 configs.s2twp 相同：先正規化相容字，
      // 以詞組斷詞，再依序做「簡 → 繁」與「繁 → 台灣用語、異體字」。
      // from / to 只為通過 ConverterBuilder 的參數檢查，實際走 configs。
      return core.ConverterBuilder({
        from: { cn: [[d.STPhrases, d.STCharacters]] },
        to: { twp: [[d.TWPhrases], [d.TWVariantsPhrases, d.TWVariants]] },
        configs: {
          s2twp: {
            normalizationChain: [[d.CJK_Compatibility_Ideographs]],
            segmentation: [
              d.STPhrases,
              d.STPhrases_GeneratedFromRegionalPhrases,
            ],
            conversionChain: [
              [
                d.STPhrases,
                d.STPhrases_GeneratedFromRegionalPhrases,
                d.STCharacters,
              ],
              [d.TWPhrases, d.TWVariantsPhrases, d.TWVariants],
            ],
          },
        },
      })({ from: "cn", to: "twp" })
    })
    .catch((error: unknown) => {
      // 載入失敗（例如部署換版後舊 chunk 不在了）不要卡死，下次按再試。
      converter = null
      throw error
    })
  return converter
}
