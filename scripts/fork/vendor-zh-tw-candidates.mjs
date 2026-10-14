#!/usr/bin/env node
// mobile fork：產生 src/lib/fork/zh-tw/candidates.ts——多義簡體字的繁體候選，
// 給轉換預覽「點一下換另一種寫法」用（例如 干 → 幹／乾／干、发 → 發／髮）。
//
// opencc-js 的字典每個字只留第一個候選，完整的候選表在 OpenCC 原始資料的
// STCharacters.txt。這支腳本從 OpenCC 固定的提交下載它：
//   - 每個候選先套臺灣異體字（TWVariants，例如 裏 → 裡），去掉重複；
//   - 轉換器實際用的預設（fork 內嵌字典的結果）排第一；
//   - 其餘候選只留在至少三個詞組（STPhrases）裡出現過的，濾掉罕用的古字。
//
//   node scripts/fork/vendor-zh-tw-candidates.mjs [OpenCC commit]
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const commit = process.argv[2] ?? "178f05dbc5dbcedd09d4ab39d501094f4d9d8820"
const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const url = `https://raw.githubusercontent.com/BYVoid/OpenCC/${commit}/data/dictionary/STCharacters.txt`

const dicts = await import(join(root, "src/lib/fork/opencc/dicts.js"))
const pairs = (dict) => dict.split("|").map((line) => line.split(" "))
const vendoredDefault = new Map(pairs(dicts.STCharacters))
const twVariant = new Map(pairs(dicts.TWVariants))
// 每個字在詞組（套過臺灣異體字之後）裡出現的次數，用來濾掉罕用字
const phraseCount = new Map()
for (const [, value] of pairs(dicts.STPhrases)) {
  for (const ch of value) {
    const tw = twVariant.get(ch) ?? ch
    phraseCount.set(tw, (phraseCount.get(tw) ?? 0) + 1)
  }
}
const MIN_PHRASES = 3

const response = await fetch(url)
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
const lines = (await response.text()).split("\n")

const table = []
for (const line of lines) {
  const [key, rest] = line.split("\t")
  if (!key || !rest) continue
  const raw = rest.trim().split(/\s+/)
  if (raw.length < 2) continue
  const first = vendoredDefault.get(key) ?? raw[0]
  const normalize = (ch) => twVariant.get(ch) ?? ch
  const candidates = [normalize(first)]
  for (const ch of raw.map(normalize)) {
    if (candidates.includes(ch)) continue
    if (ch !== key && (phraseCount.get(ch) ?? 0) < MIN_PHRASES) continue
    candidates.push(ch)
  }
  if (candidates.length > 1) table.push([key, candidates])
}

const body = table
  .map(
    ([key, candidates]) =>
      `  ${JSON.stringify(key)}: ${JSON.stringify(candidates)},`
  )
  .join("\n")
writeFileSync(
  join(root, "src/lib/fork/zh-tw/candidates.ts"),
  `// 多義簡體字的繁體候選（第一個是轉換器的預設）。由
// scripts/fork/vendor-zh-tw-candidates.mjs 從 OpenCC ${commit.slice(0, 12)} 的
// data/dictionary/STCharacters.txt 產生，不要手改。授權：Apache-2.0（見 ../opencc/LICENSE）。
export const CHAR_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
${body}
}
`
)
console.log(
  `wrote ${table.length} ambiguous characters from OpenCC ${commit.slice(0, 12)}`
)
