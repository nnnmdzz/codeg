// mobile fork：簡體 → 繁體（臺灣用語）的轉換引擎。
//
// 演算法跟 opencc-js 的 s2twp 一樣，字典也是同一份（見 ../opencc），但每一段
// 都記下從哪段原文轉來、為什麼這樣轉、還能換成什麼，給轉換預覽點選用。在那
// 之上多做了四件事：
//
// 1. 閘門：只轉真的是簡體的地方。以分句判斷：含簡體專用字的句子才轉；同一句
//    混著繁體時，繁體字和緊鄰它的簡繁共用字（干、台、后、里⋯）不動。已經是
//    繁體的字，不會被「臺灣用語」再改一次（例如你自己打的「權限」「項目」）。
// 2. 覆寫：個人詞庫 > 新增用語、兩可用語與例外（./rules）> OpenCC。比對的是
//    簡體原文。新增用語若會切斷 OpenCC 認得的詞組（「合并发送」裡的「并发」），
//    就不套用。
// 3. OpenCC：分詞 → 簡轉繁 → 臺灣用語；臺灣用語依 ./rules 拿掉錯的、把兩可的
//    改成可選。
// 4. 寫法：日常寫「台」，正式寫「臺」；正式寫法另外套用 TW_PHRASES_FORMAL。
//
// 標點不在這裡處理（見 ../taiwan-punctuation）。
import { CHAR_CANDIDATES } from "./candidates"
import * as RULES from "./rules"

/** 用語規則（見 ./rules）。測試可以換掉，例如清空後跟 OpenCC 逐筆比對。 */
export interface ZhTwRules {
  readonly TW_PHRASES_DROPPED: readonly string[]
  readonly TW_PHRASES_OPTIONAL: readonly string[]
  readonly TW_PHRASES_FORMAL: readonly string[]
  readonly ADDED_TERMS: readonly (readonly [string, string])[]
  readonly OPTIONAL_TERMS: readonly (readonly [string, string])[]
  readonly NOT_AT_CLAUSE_END: readonly string[]
  readonly GUARDS: readonly string[]
  readonly CHAR_PREFERENCES: Readonly<Record<string, readonly [string, string]>>
}

export type ZhTwStyle = "everyday" | "formal"

/** 可以點選的原因：臺灣用語、日常／正式寫法、多義字、個人詞庫 */
export type PieceReason = "term" | "style" | "char" | "personal"

export interface Piece {
  /** 原文 */
  readonly source: string
  /** 轉換結果 */
  readonly text: string
  /** 能換的寫法，第一個是引擎的預設；沒有就不能點選 */
  readonly options?: readonly string[]
  readonly reason?: PieceReason
  /** 用了這則草稿點選過的寫法 */
  readonly chosen?: boolean
}

export interface ConvertOptions {
  readonly style?: ZhTwStyle
  /**
   * 整則草稿大致是簡體（見 leansSimplified）。這時連簡繁同形的片段（「保存」
   * 「刷新」）也照簡體轉；否則只轉含簡體專用字的地方，繁體原樣保留。
   */
  readonly assumeSimplified?: boolean
  /** 這則草稿點選過的寫法：原文 → 寫法 */
  readonly choices?: ReadonlyMap<string, string>
  /** 個人詞庫：簡體原文 → 寫法 */
  readonly personal?: ReadonlyMap<string, string>
}

export interface ZhTwEngine {
  /** 轉換後的文字（等於 pieces 接起來） */
  convert(text: string, options?: ConvertOptions): string
  pieces(text: string, options?: ConvertOptions): Piece[]
  /** 有沒有簡體專用字 */
  hasSimplified(text: string): boolean
  /** 簡體專用字比繁體專用字多：整則草稿大致是簡體 */
  leansSimplified(text: string): boolean
}

/** 引擎用到的 OpenCC 字典（../opencc/dicts.js 的格式："原 換|原 換"） */
export interface ZhTwDicts {
  readonly CJK_Compatibility_Ideographs: string
  readonly STCharacters: string
  readonly STPhrases: string
  readonly STPhrases_GeneratedFromRegionalPhrases: string
  readonly TWPhrases: string
  readonly TWVariants: string
  readonly TWVariantsPhrases: string
}

interface TrieNode<T> {
  next?: Map<string, TrieNode<T>>
  value?: T
}

/** 以字（code point）為單位的字典樹，找最長的相符詞。 */
class Trie<T> {
  private readonly root: TrieNode<T> = {}

  set(key: string, value: T) {
    let node = this.root
    for (const ch of key) {
      node.next ??= new Map()
      let child = node.next.get(ch)
      if (!child) {
        child = {}
        node.next.set(ch, child)
      }
      node = child
    }
    node.value = value
  }

  longest(
    chars: readonly string[],
    start: number,
    limit = chars.length
  ): { end: number; value: T } | null {
    let node: TrieNode<T> | undefined = this.root
    let best: { end: number; value: T } | null = null
    for (let i = start; i < limit; i++) {
      node = node.next?.get(chars[i])
      if (!node) break
      if (node.value !== undefined) best = { end: i + 1, value: node.value }
    }
    return best
  }
}

function entries(dict: string): [string, string][] {
  if (!dict) return []
  return dict.split("|").map((line) => {
    const space = line.indexOf(" ")
    return [line.slice(0, space), line.slice(space + 1)]
  })
}

/** 跟 opencc-js 的字典群組一樣：同一個鍵，排在前面的字典優先。 */
function loadGroup<T>(
  trie: Trie<T>,
  dicts: readonly string[],
  value: (source: string, target: string, dictIndex: number) => T | null
) {
  for (let d = dicts.length - 1; d >= 0; d--) {
    for (const [source, target] of entries(dicts[d])) {
      const v = value(source, target, d)
      if (v !== null) trie.set(source, v)
    }
  }
}

/** 第二階段（臺灣用語、異體字）的一條規則 */
interface TwRule {
  readonly out: string
  readonly kind: "term" | "optional" | "formal" | "variant"
}

/** 覆寫：新增用語、兩可用語、例外、個人詞庫 */
interface Override {
  readonly kind: "added" | "optional" | "guard" | "personal"
  readonly out?: string
}

/** 第一階段（簡轉繁）的一段 */
interface StageOne {
  from: number
  to: number
  out: string[]
  /** 由兩字以上的詞組決定的（多義字已經有語境） */
  phrase: boolean
  /** 輸出裡「台」字的位置（日常寫「台」、正式寫「臺」） */
  tai: number[]
}

/** 單獨出現時預設幾乎不會錯的多義字，不標示（里 → 裡、后 → 後） */
const QUIET_CHARS = new Set(["里", "后"])

const HAN = /\p{Script=Han}/u

const CLAUSE_END = new Set([
  "，",
  "。",
  "！",
  "？",
  "；",
  "：",
  "、",
  "\n",
  ",",
  ".",
  "!",
  "?",
  ";",
  ":",
])

export function createEngine(
  d: ZhTwDicts,
  rules: ZhTwRules = RULES
): ZhTwEngine {
  const {
    ADDED_TERMS,
    CHAR_PREFERENCES,
    GUARDS,
    NOT_AT_CLAUSE_END,
    OPTIONAL_TERMS,
    TW_PHRASES_DROPPED,
    TW_PHRASES_FORMAL,
    TW_PHRASES_OPTIONAL,
  } = rules
  const compat = new Map(entries(d.CJK_Compatibility_Ideographs))

  // 簡體專用字：STCharacters 的鍵，且不曾出現在任何轉換結果裡（干、台、后、
  // 里 這些繁體也用的字不算）。繁體專用字：只出現在轉換結果、本身不是鍵的字。
  // 臺灣的寫法（TWVariants 等的結果，例如 群、峰）也算繁體：OpenCC 的繁體
  // 標準寫成 羣、峯，臺灣異體字表才換回來。
  const traditionalChars = new Set<string>()
  const stCharacters = entries(d.STCharacters)
  for (const [, target] of [
    ...stCharacters,
    ...entries(d.STPhrases),
    ...entries(d.TWVariants),
    ...entries(d.TWVariantsPhrases),
    ...entries(d.TWPhrases),
  ]) {
    for (const ch of target) traditionalChars.add(ch)
  }
  const stKeys = new Set(stCharacters.map(([k]) => k))
  const simplifiedOnly = new Set(
    [...stKeys].filter((k) => !traditionalChars.has(k))
  )
  const traditionalOnly = new Set<string>()
  for (const [, target] of stCharacters) {
    for (const ch of target) if (!stKeys.has(ch)) traditionalOnly.add(ch)
  }
  /** 簡繁共用、但在簡體裡另有對應的字（干、台、后、里⋯） */
  const shared = (ch: string) => stKeys.has(ch) && traditionalChars.has(ch)

  const segmentation = new Trie<true>()
  loadGroup(
    segmentation,
    [d.STPhrases, d.STPhrases_GeneratedFromRegionalPhrases],
    () => true
  )

  const stageOne = new Trie<string>()
  loadGroup(
    stageOne,
    [d.STPhrases, d.STPhrases_GeneratedFromRegionalPhrases, d.STCharacters],
    (_s, t) => t
  )

  const dropped = new Set(TW_PHRASES_DROPPED)
  const optional = new Set(TW_PHRASES_OPTIONAL)
  const formal = new Set(TW_PHRASES_FORMAL)
  const stageTwo = new Trie<TwRule>()
  loadGroup(
    stageTwo,
    [d.TWPhrases, d.TWVariantsPhrases, d.TWVariants],
    (s, t, i) => {
      if (i > 0) return { out: t, kind: "variant" }
      if (dropped.has(s)) return null
      return {
        out: t,
        kind: optional.has(s) ? "optional" : formal.has(s) ? "formal" : "term",
      }
    }
  )
  const variants = new Trie<string>()
  loadGroup(variants, [d.TWVariantsPhrases, d.TWVariants], (_s, t) => t)

  const notAtEnd = new Set(NOT_AT_CLAUSE_END)
  const overrides = new Trie<Override>()
  for (const key of GUARDS) overrides.set(key, { kind: "guard" })
  for (const [key, out] of OPTIONAL_TERMS)
    overrides.set(key, { kind: "optional", out })
  for (const [key, out] of ADDED_TERMS)
    overrides.set(key, { kind: "added", out })

  let personalSource: ReadonlyMap<string, string> | undefined
  let personalTrie: Trie<Override> | null = null
  const personalOverrides = (personal?: ReadonlyMap<string, string>) => {
    if (!personal || personal.size === 0) return null
    if (personal !== personalSource) {
      personalSource = personal
      personalTrie = new Trie<Override>()
      for (const [key, out] of personal) {
        if (key) personalTrie.set(key, { kind: "personal", out })
      }
    }
    return personalTrie
  }

  /** 用字典樹整段替換（給異體字用） */
  function replaceAll(trie: Trie<string>, chars: readonly string[]): string {
    let out = ""
    for (let i = 0; i < chars.length; ) {
      const hit = trie.longest(chars, i)
      if (hit) {
        out += hit.value
        i = hit.end
      } else {
        out += chars[i]
        i++
      }
    }
    return out
  }

  /** OpenCC 的分詞：字典裡的詞各成一段，其餘連續的字合成一段。 */
  function segment(chars: readonly string[]): [number, number][] {
    const segments: [number, number][] = []
    let unmatched = -1
    for (let i = 0; i < chars.length; ) {
      const hit = segmentation.longest(chars, i)
      if (hit) {
        if (unmatched >= 0) {
          segments.push([unmatched, i])
          unmatched = -1
        }
        segments.push([i, hit.end])
        i = hit.end
      } else {
        if (unmatched < 0) unmatched = i
        i++
      }
    }
    if (unmatched >= 0) segments.push([unmatched, chars.length])
    return segments
  }

  /** 第一階段：簡轉繁，加上字形偏好；記下 OpenCC 選了「臺」的地方。 */
  function stageOneOf(norm: readonly string[]): StageOne[] {
    const parts: StageOne[] = []
    for (let i = 0; i < norm.length; ) {
      const hit = stageOne.longest(norm, i)
      const to = hit ? hit.end : i + 1
      const out = hit ? Array.from(hit.value) : [norm[i]]
      const part: StageOne = { from: i, to, out, phrase: to - i > 1, tai: [] }
      if (out.length === to - i) {
        for (let k = 0; k < out.length; k++) {
          const source = norm[i + k]
          const preference = CHAR_PREFERENCES[source]
          if (preference && out[k] === preference[0]) out[k] = preference[1]
          if (source === "台" && out[k] === "臺") part.tai.push(k)
        }
      }
      parts.push(part)
      i = to
    }
    return parts
  }

  /** 第一階段輸出裡，由原文「台」轉成「臺」的位置 */
  function taiPositions(parts: readonly StageOne[]): Set<number> {
    const positions = new Set<number>()
    let offset = 0
    for (const part of parts) {
      for (const k of part.tai) positions.add(offset + k)
      offset += part.out.length
    }
    return positions
  }

  /**
   * 「台」的寫法：臺灣用語套完之後還是「臺」、由原文「台」轉來的字，日常寫
   * 「台」。OpenCC 自己會把「臺積電」換回「台積電」，所以要等第二階段之後
   * 才決定。chunk 與第一階段輸出逐字對應（從 from 開始）；回傳可選的位置。
   */
  function styleTai(
    chunk: string[],
    from: number,
    taiAt: ReadonlySet<number>,
    style: ZhTwStyle
  ): number[] {
    const positions: number[] = []
    chunk.forEach((ch, k) => {
      if (ch === "臺" && taiAt.has(from + k)) {
        positions.push(k)
        if (style === "everyday") chunk[k] = "台"
      }
    })
    return positions
  }

  /** 只轉字形（含「台」的寫法），不換臺灣用語：「保留原詞」的寫法。 */
  function scriptOf(chars: readonly string[], style: ZhTwStyle): string {
    const norm = chars.map((c) => compat.get(c) ?? c)
    let out = ""
    for (const [s, e] of segment(norm)) {
      const one = stageOneOf(norm.slice(s, e))
      const flat = one.flatMap((p) => p.out)
      const script = Array.from(replaceAll(variants, flat))
      if (script.length === flat.length)
        styleTai(script, 0, taiPositions(one), style)
      out += script.join("")
    }
    return out
  }

  /** OpenCC 的三個階段（分詞、簡轉繁、臺灣用語），每段記下可換的寫法。 */
  function openccPieces(chars: readonly string[], style: ZhTwStyle): Piece[] {
    const norm = chars.map((c) => compat.get(c) ?? c)
    const pieces: Piece[] = []
    for (const [s, e] of segment(norm)) {
      const segNorm = norm.slice(s, e)
      const segSource = chars.slice(s, e)
      const one = stageOneOf(segNorm)
      const taiAt = taiPositions(one)
      const flat: string[] = []
      const owner: number[] = []
      one.forEach((part, index) => {
        for (const ch of part.out) {
          flat.push(ch)
          owner.push(index)
        }
      })

      // 第二階段：臺灣用語與異體字。一個詞若只蓋到第一階段某段的一部分，
      // 跟相鄰的詞併成同一段，原文與結果才對得起來。
      type Token = { a: number; b: number; rule: TwRule | null }
      const tokens: Token[] = []
      for (let k = 0; k < flat.length; ) {
        const hit = stageTwo.longest(flat, k)
        if (hit) {
          tokens.push({ a: k, b: hit.end, rule: hit.value })
          k = hit.end
        } else {
          tokens.push({ a: k, b: k + 1, rule: null })
          k++
        }
      }
      const groups: Token[][] = []
      for (const token of tokens) {
        const last = groups[groups.length - 1]
        const lastToken = last?.[last.length - 1]
        if (lastToken && owner[lastToken.b - 1] === owner[token.a])
          last.push(token)
        else groups.push([token])
      }

      for (const group of groups) {
        const first = owner[group[0].a]
        const last = owner[group[group.length - 1].b - 1]
        const source = segSource.slice(one[first].from, one[last].to).join("")
        let text = ""
        let other = ""
        let reason: PieceReason | undefined
        /** 「台」可選的位置（在 text 裡，以字計） */
        const taiChoices: number[] = []
        let textLength = 0
        for (const token of group) {
          const raw = flat.slice(token.a, token.b)
          const scriptChars = Array.from(replaceAll(variants, raw))
          if (scriptChars.length === raw.length)
            styleTai(scriptChars, token.a, taiAt, style)
          const script = scriptChars.join("")
          const rule = token.rule
          let piece: string
          if (!rule || rule.kind === "variant") {
            const plainChars = rule ? Array.from(rule.out) : [...raw]
            if (plainChars.length === raw.length) {
              for (const k of styleTai(plainChars, token.a, taiAt, style)) {
                taiChoices.push(textLength + k)
              }
            }
            piece = plainChars.join("")
            other += piece
          } else if (rule.kind === "term") {
            piece = rule.out
            other += script
            reason ??= "term"
          } else if (rule.kind === "optional") {
            piece = script
            other += rule.out
            reason ??= "term"
          } else {
            const formalWord = style === "formal"
            piece = formalWord ? rule.out : script
            other += formalWord ? script : rule.out
            reason ??= "style"
          }
          text += piece
          textLength += Array.from(piece).length
        }

        if (reason) {
          pieces.push({ source, text, options: [text, other], reason })
          continue
        }
        // 「台」的寫法：只讓那個字可以點選——OpenCC 的分詞可能把它跟後面的
        // 字切成一段（这台电脑 → 台電／腦）
        if (taiChoices.length > 0) {
          const sourceChars = Array.from(source)
          const textChars = Array.from(text)
          if (sourceChars.length !== textChars.length) {
            const swapped = textChars
              .map((ch, k) =>
                taiChoices.includes(k) ? (ch === "台" ? "臺" : "台") : ch
              )
              .join("")
            pieces.push({
              source,
              text,
              options: [text, swapped],
              reason: "style",
            })
            continue
          }
          let plainSource = ""
          let plainText = ""
          const flushPlain = () => {
            if (plainText) pieces.push({ source: plainSource, text: plainText })
            plainSource = plainText = ""
          }
          textChars.forEach((ch, k) => {
            if (taiChoices.includes(k)) {
              flushPlain()
              pieces.push({
                source: sourceChars[k],
                text: ch,
                options: [ch, ch === "台" ? "臺" : "台"],
                reason: "style",
              })
            } else {
              plainSource += sourceChars[k]
              plainText += ch
            }
          })
          flushPlain()
          continue
        }
        // 多義字：由單字預設決定（沒有詞組的語境）、而且真的換了字，才列出
        // 候選。了、只、面 這些預設不換的字太常見，每個都標會滿畫面都是。
        const owners = one.slice(first, last + 1)
        const only = owners.length === 1 ? owners[0] : null
        const char =
          only && !only.phrase && only.to - only.from === 1
            ? segNorm[only.from]
            : ""
        const candidates =
          char && !QUIET_CHARS.has(char) ? CHAR_CANDIDATES[char] : undefined
        if (candidates && text !== char && candidates.includes(text)) {
          const options = [text, ...candidates.filter((c) => c !== text)]
          pieces.push({ source, text, options, reason: "char" })
          continue
        }
        pieces.push({ source, text })
      }
    }
    return pieces
  }

  /** OpenCC 認得的詞組的邊界：新增用語不能從詞組中間切開。 */
  function phraseSpans(chars: readonly string[]): [number, number][] {
    const norm = chars.map((c) => compat.get(c) ?? c)
    const spans: [number, number][] = []
    for (let i = 0; i < norm.length; ) {
      const hit = segmentation.longest(norm, i)
      if (hit && hit.end - i > 1) {
        spans.push([i, hit.end])
        i = hit.end
      } else {
        i++
      }
    }
    return spans
  }

  /** 轉一段（確定要轉的）簡體：覆寫優先，其餘交給 OpenCC。 */
  function convertSpan(
    chars: readonly string[],
    options: ConvertOptions
  ): Piece[] {
    const style = options.style ?? "everyday"
    const personal = personalOverrides(options.personal)
    const spans = phraseSpans(chars)
    const cuts = (from: number, to: number) =>
      spans.some(([a, b]) => (a < from && from < b) || (a < to && to < b))
    const pieces: Piece[] = []
    let gap = 0
    const flush = (end: number) => {
      if (end > gap) pieces.push(...openccPieces(chars.slice(gap, end), style))
    }
    for (let i = 0; i < chars.length; ) {
      const mine = personal?.longest(chars, i) ?? null
      let rule = overrides.longest(chars, i)
      if (rule && rule.value.kind !== "guard" && cuts(i, rule.end)) rule = null
      if (
        rule &&
        notAtEnd.has(chars.slice(i, rule.end).join("")) &&
        !HAN.test(chars[rule.end] ?? "")
      ) {
        rule = { end: rule.end, value: { kind: "guard" } }
      }
      const hit = mine && (!rule || mine.end >= rule.end) ? mine : rule
      if (!hit) {
        i++
        continue
      }
      flush(i)
      const sourceChars = chars.slice(i, hit.end)
      const source = sourceChars.join("")
      const script = scriptOf(sourceChars, style)
      const { kind, out = script } = hit.value
      if (kind === "guard") {
        pieces.push({ source, text: script })
      } else if (kind === "optional") {
        pieces.push({
          source,
          text: script,
          options: [script, out],
          reason: "term",
        })
      } else if (kind === "added") {
        pieces.push({
          source,
          text: out,
          options: [out, script],
          reason: "term",
        })
      } else {
        // 個人詞庫：另一種寫法是沒有個人詞庫時的結果
        const base = convertSpan(sourceChars, { style })
          .map((p) => p.text)
          .join("")
        const options = base === out ? [out, script] : [out, base]
        pieces.push({
          source,
          text: out,
          options: options[0] === options[1] ? undefined : options,
          reason: "personal",
        })
      }
      i = hit.end
      gap = i
    }
    flush(chars.length)
    return pieces
  }

  /** 分句判斷要不要轉；同一句混著繁體時，只轉簡體的部分。 */
  function convertRun(text: string, options: ConvertOptions): Piece[] {
    const chars = Array.from(text)
    let simplifiedCount = 0
    let traditionalCount = 0
    for (const ch of chars) {
      if (simplifiedOnly.has(ch)) simplifiedCount++
      else if (traditionalOnly.has(ch)) traditionalCount++
    }
    const mostlySimplified =
      options.assumeSimplified ?? simplifiedCount > traditionalCount
    if (simplifiedCount === 0 && !options.assumeSimplified)
      return [{ source: text, text }]

    const pieces: Piece[] = []
    const keep = (from: number, to: number) => {
      if (to > from) {
        const s = chars.slice(from, to).join("")
        pieces.push({ source: s, text: s })
      }
    }
    let start = 0
    for (let i = 0; i <= chars.length; i++) {
      if (i < chars.length && !CLAUSE_END.has(chars[i])) continue
      const end = Math.min(i + 1, chars.length)
      const clause = chars.slice(start, end)
      const hasS = clause.some((ch) => simplifiedOnly.has(ch))
      const hasT = clause.some((ch) => traditionalOnly.has(ch))
      if (hasS && hasT) {
        // 混著寫：繁體字與緊鄰它的共用字不動，其餘含簡體的片段才轉
        const fixed = clause.map(
          (ch, k) =>
            traditionalOnly.has(ch) ||
            (shared(ch) &&
              (traditionalOnly.has(clause[k - 1] ?? "") ||
                traditionalOnly.has(clause[k + 1] ?? "")))
        )
        let runStart = 0
        for (let k = 0; k <= clause.length; k++) {
          if (k < clause.length && fixed[k] === fixed[runStart]) continue
          const run = clause.slice(runStart, k)
          if (!fixed[runStart] && run.some((ch) => simplifiedOnly.has(ch))) {
            pieces.push(...convertSpan(run, options))
          } else {
            keep(start + runStart, start + k)
          }
          runStart = k
        }
      } else if (hasS || (!hasT && mostlySimplified)) {
        pieces.push(...convertSpan(clause, options))
      } else {
        keep(start, end)
      }
      start = end
    }
    return pieces
  }

  /** 套用這則草稿點選過的寫法，並把相鄰的純文字段併起來。 */
  function finish(
    pieces: Piece[],
    choices?: ReadonlyMap<string, string>
  ): Piece[] {
    const out: Piece[] = []
    for (const piece of pieces) {
      // 選項都一樣（新增用語恰好等於只轉字形的結果）就不必點選
      let p: Piece =
        piece.options && new Set(piece.options).size < 2
          ? { source: piece.source, text: piece.text }
          : piece
      const chosen = choices?.get(piece.source)
      if (
        chosen !== undefined &&
        p.options?.includes(chosen) &&
        chosen !== p.text
      ) {
        p = { ...p, text: chosen, chosen: true }
      }
      const prev = out[out.length - 1]
      if (prev && !prev.options && !p.options) {
        out[out.length - 1] = {
          source: prev.source + p.source,
          text: prev.text + p.text,
        }
      } else {
        out.push(p)
      }
    }
    return out
  }

  return {
    pieces(text, options = {}) {
      return finish(convertRun(text, options), options.choices)
    },
    convert(text, options = {}) {
      return finish(convertRun(text, options), options.choices)
        .map((p) => p.text)
        .join("")
    },
    hasSimplified(text) {
      for (const ch of text) if (simplifiedOnly.has(ch)) return true
      return false
    },
    leansSimplified(text) {
      let balance = 0
      for (const ch of text) {
        if (simplifiedOnly.has(ch)) balance++
        else if (traditionalOnly.has(ch)) balance--
      }
      return balance > 0
    },
  }
}
