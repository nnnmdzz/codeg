// Types for the vendored opencc-js core (core.js) — only what the fork uses.
// Mirrors opencc-js@1.4.2 types/core.d.ts.

export type DictLike = string | readonly (readonly [string, string])[]
export type DictGroup = readonly DictLike[]
export type ConverterFunction = (text: string) => string

export interface LocalePreset {
  from: Record<string, readonly DictGroup[]>
  to: Record<string, readonly DictGroup[]>
  configs?: Record<
    string,
    {
      normalizationChain?: readonly DictGroup[]
      segmentation?: DictLike | DictGroup
      conversionChain: readonly DictGroup[]
    }
  >
}

export function ConverterBuilder(
  localePreset: LocalePreset
): (options: { from: string; to: string }) => ConverterFunction
