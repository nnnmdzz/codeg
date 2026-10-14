// mobile fork：載入繁體轉換引擎（./engine，字典見 ../opencc）。
//
// 字典約 1.1 MB，第一次需要時才以動態 import 載入，成為獨立的 chunk，不影響
// 頁面平常的載入；之後重複使用同一個引擎。
import type { Editor } from "@tiptap/core"
import { taiwanPunctuation } from "../taiwan-punctuation"
import { getDraftChoices } from "./draft-choices"
import type { ConvertOptions, ZhTwEngine } from "./engine"
import { personalSetting, styleSetting } from "./settings"

let engine: Promise<ZhTwEngine> | null = null
let loaded: ZhTwEngine | null = null
const listeners = new Set<() => void>()

export function loadZhTw(): Promise<ZhTwEngine> {
  engine ??= Promise.all([import("./engine"), import("../opencc/dicts")])
    .then(([{ createEngine }, dicts]) => {
      loaded = createEngine(dicts)
      for (const listener of listeners) listener()
      return loaded
    })
    .catch((error: unknown) => {
      // 載入失敗（例如部署換版後舊 chunk 不在了）不要卡死，下次再試。
      engine = null
      throw error
    })
  return engine
}

/** 已經載入好的引擎，還沒載入時為 null。傳送前自動轉換靠它同步轉換。 */
export function getLoadedZhTw(): ZhTwEngine | null {
  return loaded
}

/** 引擎載入完成時通知（不論是誰觸發的載入）。 */
export function subscribeZhTwLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 這則草稿轉換時用的選項：目前的寫法與個人詞庫、這則草稿點選過的寫法，
 * 以及整則草稿大致是不是簡體（決定簡繁同形的片段要不要轉）。
 */
export function draftOptions(zh: ZhTwEngine, editor: Editor): ConvertOptions {
  return {
    style: styleSetting.get(),
    personal: personalSetting.get(),
    choices: getDraftChoices(editor),
    assumeSimplified: zh.leansSimplified(editor.state.doc.textContent),
  }
}

/** 轉換一段草稿文字：字與詞（引擎）之後，標點也換成臺灣的寫法。 */
export function draftConverter(
  zh: ZhTwEngine,
  editor: Editor
): (text: string) => string {
  const options = draftOptions(zh, editor)
  return (text) => taiwanPunctuation(zh.convert(text, options))
}
