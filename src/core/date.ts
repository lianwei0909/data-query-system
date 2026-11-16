// 日期工具：班表日期列统一为带年份的 YYYY-MM-DD；排班周期 = 上月 21 日 ~ 本月 20 日

export const pad2 = (n: number): string => (n < 10 ? '0' : '') + n

export function ymdKey(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`
}
export const isYmdKey = (k: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(k))
export const dateToKey = (d: Date): string => ymdKey(d.getFullYear(), d.getMonth() + 1, d.getDate())

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，北京时间 0~8 点会变成前一天） */
export const localDateStr = (d: Date = new Date()): string => dateToKey(d)

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000)
}

export interface DateParts { y: number | null; m: number; d: number }

/** 支持：2026-11-21 / 2026/11/21 / 2026年11月21日 / 11月21日 / 11月21号 */
export function parseDateKey(key: unknown): DateParts | null {
  const s = String(key ?? '').trim()
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?$/)
  if (m) return { y: +m[1], m: +m[2], d: +m[3] }
  m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/)
  if (m) return { y: null, m: +m[1], d: +m[2] }
  return null
}

/**
 * 给没有年份的日期列推断年份：按列顺序遇到月份回绕（12 月 → 1 月）年份 +1；
 * 起始年份取「这段日期中点离参考日期最近」的那一年。返回 { 原列名: 'YYYY-MM-DD' }。
 */
export function inferDateKeys(keys: string[], refDate: Date = new Date()): Record<string, string> {
  const out: Record<string, string> = {}
  const seq: { k: string; m: number; d: number }[] = []
  for (const k of keys) {
    const p = parseDateKey(k)
    if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) continue
    if (p.y) out[k] = ymdKey(p.y, p.m, p.d)
    else seq.push({ k, m: p.m, d: p.d })
  }
  if (!seq.length) return out
  const offs = [0]
  let off = 0
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].m < seq[i - 1].m - 6) off++
    offs.push(off)
  }
  const mid = Math.floor(seq.length / 2)
  let best = { y: refDate.getFullYear(), dist: Infinity }
  for (let y = refDate.getFullYear() - 1; y <= refDate.getFullYear() + 1; y++) {
    const dist = Math.abs(new Date(y + offs[mid], seq[mid].m - 1, seq[mid].d).getTime() - refDate.getTime())
    if (dist < best.dist) best = { y, dist }
  }
  seq.forEach((s, j) => { out[s.k] = ymdKey(best.y + offs[j], s.m, s.d) })
  return out
}

export interface Period { start: Date; end: Date }
/** 包含 day 的排班周期：day >= 21 号 → 本月 21 日 ~ 下月 20 日；否则上月 21 日 ~ 本月 20 日 */
export function periodOf(day: Date): Period {
  const y = day.getFullYear(), m = day.getMonth()
  const start = day.getDate() >= 21 ? new Date(y, m, 21) : new Date(y, m - 1, 21)
  return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 20) }
}
