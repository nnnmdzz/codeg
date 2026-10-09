// mobile fork：把標點換成臺灣的習慣寫法。轉繁體時，在字的轉換（s2twp）之後
// 套用；OpenCC 只轉字和詞，不轉標點。
//
// - 引號：“ ” → 「 」，‘ ’ → 『 』。只換用在中文裡的：引號旁邊或裡面有中文
//   才換，英文的 “quote”、don’t 不動。
// - 間隔號：兩個中文字之間的 ·（或 ・）→ ‧，例如 列夫‧托爾斯泰。
// - 破折號：—— → ──。
// - 跟在中文後面的半形 , . ? ! : ; 換成全形，並拿掉緊接的一個半形空格。
//   句號另外要求後面是結尾、空白或中文，「說明.txt」「進入./src」不動。
// - 直的引號 " ' 不動：沒包在反引號裡的指令也可能用到。
const HAN = /\p{Script=Han}/u
/** 中文的標點、括號與引號：引號旁邊是這些，也算用在中文裡 */
const CJK_PUNCT = /[　-〿！-･‥…‧─]/u
/** 句末或後面能接全形標點的中文符號 */
const CJK_CLOSING = new Set(["」", "』", "）", "》", "〉", "】", "…"])

const FULL_WIDTH: Record<string, string> = {
  ",": "，",
  ".": "。",
  "?": "？",
  "!": "！",
  ":": "：",
  ";": "；",
}

const isHan = (ch: string | undefined) => ch !== undefined && HAN.test(ch)
const isCjk = (ch: string | undefined) =>
  ch !== undefined && (HAN.test(ch) || CJK_PUNCT.test(ch))
const isSpace = (ch: string | undefined) => ch === " " || ch === "\t"
const isLineEnd = (ch: string | undefined) =>
  ch === undefined || ch === "\n" || ch === "\r"

/** 從 open 之後找到對應的 close；這一對引號用在中文裡就換。 */
function quotedChinese(
  chars: string[],
  open: number,
  close: string,
  before: string | undefined
): boolean {
  if (isCjk(before) || isCjk(chars[open + 1])) return true
  const end = chars.indexOf(close, open + 1)
  const inner = end === -1 ? chars.slice(open + 1) : chars.slice(open + 1, end)
  return inner.some(isHan) || (end !== -1 && isCjk(chars[end + 1]))
}

export function taiwanPunctuation(text: string): string {
  const chars = Array.from(text)
  const out: string[] = []
  // 已經換成「『、還沒遇到對應收尾的數量
  let openDouble = 0
  let openSingle = 0
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    const prev = out[out.length - 1]
    const next = chars[i + 1]

    if (c === "“") {
      if (quotedChinese(chars, i, "”", prev)) {
        out.push("「")
        openDouble++
        continue
      }
    } else if (c === "”") {
      if (openDouble > 0 || isCjk(prev) || isCjk(next)) {
        out.push("」")
        if (openDouble > 0) openDouble--
        continue
      }
    } else if (c === "‘") {
      if (quotedChinese(chars, i, "’", prev)) {
        out.push("『")
        openSingle++
        continue
      }
    } else if (c === "’") {
      // 前面不是中文的 ’ 多半是英文的撇號（don’t），不動
      if (openSingle > 0 || isCjk(prev)) {
        out.push("』")
        if (openSingle > 0) openSingle--
        continue
      }
    } else if ((c === "·" || c === "・") && isHan(prev) && isHan(next)) {
      out.push("‧")
      continue
    } else if (c === "—" && next === "—") {
      out.push("──")
      i++
      continue
    } else if (
      c in FULL_WIDTH &&
      (isHan(prev) || CJK_CLOSING.has(prev ?? "")) &&
      (c !== "." ||
        isLineEnd(next) ||
        isSpace(next) ||
        isCjk(next) ||
        next === "”" ||
        next === "’")
    ) {
      out.push(FULL_WIDTH[c])
      // 全形標點本身帶空白，後面那一個半形空格拿掉（行尾的不動）
      if (isSpace(next) && !isLineEnd(chars[i + 2]) && !isSpace(chars[i + 2])) {
        i++
      }
      continue
    }
    out.push(c)
  }
  return out.join("")
}
