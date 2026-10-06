#!/usr/bin/env node
// mobile fork：把 opencc-js 的「簡體 → 繁體（台灣用語）」所需部分抽進
// src/lib/fork/opencc/，給 composer 的「轉為繁體」按鈕用。
//
// 不加進 package.json：fork 的 lockfile 一旦和上游不同，上游每次改依賴，
// 自動更新的 rebase 都會卡在 pnpm-lock.yaml。抽出來的檔案只在 fork 自己的
// 目錄裡，上游怎麼改都不會衝突。
//
//   node scripts/fork/vendor-opencc.mjs [版本，預設 1.4.2]
//
// 會從 npm 下載該版本（npm pack），寫出：
//   core.js        opencc-js 的 dist/esm-lib/core.js，原封不動
//   dicts.js       s2twp 用到的七個字典，各自 export
//   LICENSE、LICENSE-Apache-2.0.txt、THIRD_PARTY_LICENSES.md
// core.d.ts / dicts.d.ts 是手寫的型別，不由這支腳本產生。
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const version = process.argv[2] ?? "1.4.2"
const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const out = join(root, "src/lib/fork/opencc")

// s2twp 的轉換鏈（opencc-js preset/cn2t.js 的 configs.s2twp）用到的字典
const DICTS = [
  "CJK_Compatibility_Ideographs",
  "STPhrases",
  "STPhrases_GeneratedFromRegionalPhrases",
  "STCharacters",
  "TWPhrases",
  "TWVariantsPhrases",
  "TWVariants",
]

const work = mkdtempSync(join(tmpdir(), "opencc-vendor-"))
try {
  execFileSync("npm", ["pack", `opencc-js@${version}`, "--silent"], {
    cwd: work,
    stdio: ["ignore", "pipe", "inherit"],
  })
  execFileSync("tar", ["xzf", `opencc-js-${version}.tgz`], { cwd: work })
  const pkg = join(work, "package")
  const header = (what) =>
    `/* eslint-disable */\n// ${what} — vendored from opencc-js@${version} by scripts/fork/vendor-opencc.mjs.\n// Do not edit; re-run the script to update. Licenses: see LICENSE files here.\n`

  writeFileSync(
    join(out, "core.js"),
    header("dist/esm-lib/core.js") +
      readFileSync(join(pkg, "dist/esm-lib/core.js"), "utf8")
  )

  const parts = DICTS.map((name) => {
    const src = readFileSync(join(pkg, `dist/esm-lib/dict/${name}.js`), "utf8")
    const match = src.match(/^export default ("(?:[^"\\]|\\.)*");?\s*$/s)
    if (!match) throw new Error(`unexpected dictionary format: ${name}`)
    return `export const ${name} = ${match[1]};\n`
  })
  writeFileSync(
    join(out, "dicts.js"),
    header(`dist/esm-lib/dict/{${DICTS.join(",")}}.js`) + parts.join("")
  )

  for (const [from, to] of [
    ["LICENSE", "LICENSE"],
    ["LICENSES/Apache-2.0.txt", "LICENSE-Apache-2.0.txt"],
    ["THIRD_PARTY_LICENSES.md", "THIRD_PARTY_LICENSES.md"],
  ]) {
    writeFileSync(join(out, to), readFileSync(join(pkg, from)))
  }
  console.log(`vendored opencc-js@${version} into ${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
