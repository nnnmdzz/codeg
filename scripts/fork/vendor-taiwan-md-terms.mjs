#!/usr/bin/env node
// mobile fork：產生 src/lib/fork/zh-tw/taiwan-md.ts——Taiwan.md 用語庫
// （https://taiwan.md/terminology/ ，CC BY-SA 4.0）裡的兩岸用語對照，給繁體
// 轉換的日常、交通、飲食⋯用語用（./rules.ts 以外的部分）。
//
// 從 frank890417/taiwan-md 固定的提交，只下載 data/terminology（稀疏、不帶
// 歷史），逐條讀 YAML：
//   - 跳過標了 auto_convert: false 的（他們確認自動替換會改壞正確文字的詞）；
//   - A、B 類（日治遺緒、1949 年後分歧）是他們轉換器的「必換」。其中有人寫
//     了詞源或說明的，預設替換；只有《大陸用語檢索手冊》1997 整批匯入、沒有
//     說明的（約一千條，混著「桌面 → 登錄」這種錯），要 rajatim/zhtw（MIT）
//     的詞庫也給出同樣的說法才預設替換，否則只當建議；
//   - C、D、E 與 semantic 是「建議」：預設不換，只在預覽提供另一種說法；
//     F（同字異義）、orthographic（字形）不收；
//   - 臺灣說法其實是「無…對應」的說明（「坐我隔壁的同學（無單詞對應）」）
//     不收；中國用語取第一種寫法、去掉括號註解；臺灣用語依「/」拆成幾種
//     說法（第一個是預設），去掉括號註解，過長的說明句不收；
//   - 簡體的鍵由繁體寫法反推，再用簡轉繁轉回去必須一模一樣才收；單字不收。
//
//   node scripts/fork/vendor-taiwan-md-terms.mjs [taiwan-md commit] [zhtw commit]
import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const commit = process.argv[2] ?? "5be123f0fec00b89c6746e6ffd9b9649a070e64d"
const zhtwCommit = process.argv[3] ?? "7c797bc984c791dbbc2a9f0c51904bb8355191bd"
const repo = "https://github.com/frank890417/taiwan-md.git"
const root = join(dirname(fileURLToPath(import.meta.url)), "../..")

const { ConverterBuilder } = await import(
  join(root, "src/lib/fork/opencc/core.js")
)
const d = await import(join(root, "src/lib/fork/opencc/dicts.js"))
// 只轉字形（含臺灣異體字）的簡轉繁：驗證反推出來的簡體鍵
const s2tw = ConverterBuilder({
  from: { cn: [[d.STPhrases, d.STCharacters]] },
  to: { tw: [[d.TWVariantsPhrases, d.TWVariants]] },
})({ from: "cn", to: "tw" })
// 繁 → 簡的單字對照：STCharacters 反過來（臺灣異體字先還原成 OpenCC 的寫法）
const pairs = (dict) => dict.split("|").map((line) => line.split(" "))
const toSimplified = new Map()
for (const [s, t] of pairs(d.STCharacters)) {
  if (!toSimplified.has(t)) toSimplified.set(t, s)
}
for (const [from, to] of pairs(d.TWVariants)) {
  if (toSimplified.has(from) && !toSimplified.has(to)) {
    toSimplified.set(to, toSimplified.get(from))
  }
}
const simplify = (text) =>
  Array.from(text, (ch) => toSimplified.get(ch) ?? ch).join("")

// rajatim/zhtw 的詞庫（簡體 → 臺灣說法），用來交叉核對整批匯入的條目
const ZHTW_FILES = [
  "base",
  "business",
  "common",
  "daily",
  "ecommerce",
  "education",
  "finance",
  "gaming",
  "geography",
  "imported",
  "it",
  "legal",
  "medical",
  "mixed",
  "social",
]
const zhtw = new Map()
for (const name of ZHTW_FILES) {
  const url = `https://raw.githubusercontent.com/rajatim/zhtw/${zhtwCommit}/src/zhtw/data/terms/cn/${name}.json`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const { terms = {} } = await response.json()
  for (const [key, value] of Object.entries(terms)) {
    if (!zhtw.has(key)) zhtw.set(key, new Set())
    zhtw.get(key).add(value)
  }
}

// taiwan-md 的 data/terminology：稀疏、不帶歷史地下載固定的提交
const work = mkdtempSync(join(tmpdir(), "taiwan-md-"))
const entries = []
let fullCommit = commit
try {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: work,
      stdio: ["ignore", "pipe", "inherit"],
    })
  git("init", "-q")
  git("remote", "add", "origin", repo)
  git("sparse-checkout", "set", "data/terminology")
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", commit)
  git("checkout", "-q", "FETCH_HEAD")
  fullCommit = git("rev-parse", "HEAD").toString().trim()
  const dir = join(work, "data/terminology")
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml") || file.startsWith("_")) continue
    try {
      const entry = parse(readFileSync(join(dir, file), "utf8"))
      if (entry && typeof entry === "object") entries.push(entry)
    } catch {
      // 讀不了的條目跳過
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

const unparen = (s) =>
  s
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim()
const HAN = /\p{Script=Han}/u
const required = new Map()
const suggested = new Map()
for (const entry of entries) {
  if (entry.auto_convert === false) continue
  const type = String(entry.fork_type ?? entry.type ?? "")
  if (!["A", "B", "C", "D", "E", "semantic"].includes(type)) continue
  const rawTaiwan = String(entry.display?.taiwan ?? entry.taiwan ?? "")
  if (/無[^/]{0,4}對應/.test(rawTaiwan)) continue
  const china = unparen(
    String(entry.display?.china ?? entry.china ?? "").split("/")[0]
  )
  const options = rawTaiwan
    .split("/")
    .map(unparen)
    .filter((o) => o && HAN.test(o) && Array.from(o).length <= 8)
  if (!china || !HAN.test(china) || options.length === 0) continue
  const key = simplify(china)
  if (Array.from(key).length < 2 || s2tw(key) !== china) continue
  const distinct = [...new Set(options)].filter((o) => o !== china)
  if (distinct.length === 0) continue

  const sources = (entry.sources ?? []).map(String)
  const bulkOnly =
    sources.length > 0 &&
    sources.every((s) => /ThunderKO|大陸用語檢索手冊/.test(s))
  const explained = Boolean(
    entry.etymology || String(entry.notes ?? "").trim() || entry.usage
  )
  const confirmed = distinct.some((o) => zhtw.get(key)?.has(o))
  const bucket =
    ["A", "B"].includes(type) && (explained || !bulkOnly || confirmed)
      ? required
      : suggested
  // 同一個鍵出現兩次：留第一次（檔名排序），預設換的優先
  if (required.has(key) || bucket.has(key)) continue
  bucket.set(key, distinct)
}
for (const key of required.keys()) suggested.delete(key)

const list = (map) =>
  [...map]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, options]) =>
        `  [${JSON.stringify(key)}, ${JSON.stringify(options)}],`
    )
    .join("\n")
writeFileSync(
  join(root, "src/lib/fork/zh-tw/taiwan-md.ts"),
  `// 兩岸用語對照，取自 Taiwan.md 用語庫（https://taiwan.md/terminology/ ，
// frank890417/taiwan-md ${fullCommit.slice(0, 12)} 的 data/terminology），由
// scripts/fork/vendor-taiwan-md-terms.mjs 產生，不要手改。
//
// 授權：CC BY-SA 4.0（https://creativecommons.org/licenses/by-sa/4.0/），
// © Taiwan.md 貢獻者。本檔是改作（只留簡體的鍵與臺灣的說法，並依
// rajatim/zhtw ${zhtwCommit.slice(0, 12)} 的詞庫分級），同樣以 CC BY-SA 4.0 授權。
//
// 簡體原文 → 臺灣的說法（第一個是預設）。
/** 預設換成臺灣的說法 */
export const TAIWAN_MD_REQUIRED: readonly (readonly [string, readonly string[]])[] = [
${list(required)}
]

/** 預設不換，預覽裡可以換 */
export const TAIWAN_MD_SUGGESTED: readonly (readonly [string, readonly string[]])[] = [
${list(suggested)}
]
`
)
console.log(
  `wrote ${required.size} required and ${suggested.size} suggested terms from taiwan-md ${fullCommit.slice(0, 12)}`
)
