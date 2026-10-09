// mobile fork：美元金額的顯示格式（費用區塊共用）。小額保留到能看出差別的位數。
/** 單價（美元／百萬 token）：整數不帶小數，其餘至少兩位。 */
export function formatRate(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 4,
  }).format(value)
}

export function formatUsd(value: number, locale: string): string {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 0.01 ? 4 : abs < 1 ? 3 : 2
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}
