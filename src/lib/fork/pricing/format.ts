// mobile fork：美元金額的顯示格式（費用區塊共用）。小額保留到能看出差別的位數。
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
