#!/usr/bin/env node
// mobile fork：Token 用量頁「費用」區塊的模型單價快照。
//
// 來源是 LiteLLM 社群維護的 model_prices_and_context_window.json（ccusage 等
// 工具共用）。只取各模型的原廠（Anthropic、OpenAI、Google、xAI、DeepSeek、
// Moonshot、智譜、MiniMax、Mistral、阿里雲），鎖定某個 commit 下載，結果可重現；
// 執行時不連 GitHub。
//
//   node scripts/fork/vendor-prices.mjs [LiteLLM commit，預設最新]
//
// 寫出 src/lib/fork/pricing/prices.json：美元／百萬 token，每個模型
// [輸入, 輸出, 快取寫入（5 分鐘）, 快取寫入（1 小時）, 快取讀取]，沒有的欄位為 null。
// key 一律小寫、去掉供應商前綴（gemini/、moonshot/ …）。
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const out = join(root, "src/lib/fork/pricing/prices.json")
const FILE = "model_prices_and_context_window.json"

// 同名時的優先順序：越前面越優先。阿里雲（dashscope）是通義千問的原廠，
// 但也轉售 GLM、Kimi、DeepSeek，所以排最後。
const PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "deepseek",
  "moonshot",
  "zai",
  "minimax",
  "mistral",
  "dashscope",
]
const MODES = new Set(["chat", "responses"])

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "codeg-fork" } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

let revision = process.argv[2]
let updatedAt = null
if (!revision) {
  const [latest] = await getJson(
    `https://api.github.com/repos/BerriAI/litellm/commits?path=${FILE}&per_page=1`
  )
  revision = latest.sha
  updatedAt = latest.commit.committer.date
}
const table = await getJson(
  `https://raw.githubusercontent.com/BerriAI/litellm/${revision}/${FILE}`
)

const perMillion = (value) =>
  typeof value === "number" ? Number((value * 1e6).toPrecision(6)) : null

const chosen = new Map() // key → { rank, prices }
for (const [rawKey, entry] of Object.entries(table)) {
  if (!entry || typeof entry !== "object") continue
  const rank = PROVIDERS.indexOf(entry.litellm_provider)
  if (rank === -1 || !MODES.has(entry.mode)) continue
  const input = perMillion(entry.input_cost_per_token)
  const output = perMillion(entry.output_cost_per_token)
  if (input === null || output === null) continue
  const key = rawKey.slice(rawKey.lastIndexOf("/") + 1).toLowerCase()
  const previous = chosen.get(key)
  if (previous && previous.rank <= rank) continue
  chosen.set(key, {
    rank,
    prices: [
      input,
      output,
      perMillion(entry.cache_creation_input_token_cost),
      perMillion(entry.cache_creation_input_token_cost_above_1hr),
      perMillion(entry.cache_read_input_token_cost),
    ],
  })
}

const keys = [...chosen.keys()].sort()
const lines = keys.map(
  (key) =>
    `    ${JSON.stringify(key)}: ${JSON.stringify(chosen.get(key).prices)}`
)
const header = {
  source: `https://github.com/BerriAI/litellm/blob/${revision}/${FILE}`,
  revision,
  updatedAt,
  unit: "USD per million tokens",
  fields: ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"],
}
const json =
  "{\n" +
  Object.entries(header)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n") +
  '\n  "models": {\n' +
  lines.join(",\n") +
  "\n  }\n}\n"
JSON.parse(json) // 寫出前確認格式正確
writeFileSync(out, json)
console.log(
  `${keys.length} models from LiteLLM ${revision.slice(0, 10)} → ${out}`
)
