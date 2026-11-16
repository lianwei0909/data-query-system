// 班次口径（全站唯一来源）：统计卡、出勤明细、日历标注、本月概览、候选名单都调用这里
import { isYmdKey, ymdKey } from './date'

export type ShiftRow = Record<string, unknown>
export type ShiftKind = 'day' | 'night' | 'rest' | 'leave'

const REST_TYPES = ['休', '休息', 'off', '年假', '年', 'leave']
const NIGHT_HINTS = ['晚', '夜', '小夜', 'night']
const SHIFT_NAME_SET = new Set(['早班', '早班2', '白班', '正常班', '日班', '夜班', '夜班2', '夜班3', '小夜', '小夜班', '小夜班2', '小夜班3', '晚班', '晚班2', '休', '休息'])
const SUMMARY_ROWS = ['日实际出勤', '争议白班值班', '争议夜班值班', '备注', '合计']

export const isRest = (v: string): boolean => REST_TYPES.includes(v)
export const isNightShift = (v: unknown): boolean => NIGHT_HINTS.some(h => String(v).includes(h))

/** 班次分类：白 / 夜 / 休 / 假（空值返回 null） */
export function classifyShift(v: unknown): { k: ShiftKind; t: string } | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/假/.test(s) || s === '年' || /leave/i.test(s)) return { k: 'leave', t: '假' }
  if (isRest(s) || /休/.test(s) || /^off$/i.test(s)) return { k: 'rest', t: '休' }
  if (isNightShift(s)) return { k: 'night', t: '夜' }
  return { k: 'day', t: '白' }
}
/** 在岗：只有白班 / 夜班算出勤，休息和各类请假都不算 */
export function isOnDuty(v: unknown): boolean {
  const c = classifyShift(v)
  return !!c && (c.k === 'day' || c.k === 'night')
}
export function isOffDay(v: unknown): boolean {
  const c = classifyShift(v)
  return !!c && (c.k === 'rest' || c.k === 'leave')
}

export function isSummaryRow(name: string): boolean {
  if (!name) return true
  if (SHIFT_NAME_SET.has(name)) return true
  return SUMMARY_ROWS.some(r => name.includes(r))
}
/** 班次 / 说明类行的名字：早班1、小夜班3、休、9 - 18 等，不是人 */
export function isShiftLikeName(s: unknown): boolean {
  const v = String(s ?? '').trim()
  if (!v || isSummaryRow(v)) return true
  if (/(班|休|假)\s*\d*$/.test(v)) return true
  if (/^\d+\s*[-~～:：]\s*\d+$/.test(v)) return true
  return false
}
export const isEnglishName = (s: unknown): boolean => /^[A-Za-z][A-Za-z0-9._\- ]*$/.test(String(s ?? '').trim())

export interface NameCols { cn: string | null; eng: string | null }
function pickCol(sample: ShiftRow, hint: string): string | null {
  return Object.keys(sample).find(k => k.includes(hint)) ?? null
}
/** 姓名列：兼容 xlsx 合并表头退化为 __EMPTY / _1 等列名 */
export function resolveNameCols(sample: ShiftRow | undefined): NameCols {
  if (!sample || typeof sample !== 'object') return { cn: null, eng: null }
  const cn = pickCol(sample, '中文') || pickCol(sample, '__EMPTY_1') || pickCol(sample, '_2')
  const eng = pickCol(sample, '英文') || pickCol(sample, '__EMPTY_2') || pickCol(sample, '__EMPTY') || pickCol(sample, '_1')
  return { cn, eng }
}
const str = (row: ShiftRow, col: string | null): string => (col ? String(row[col] ?? '').trim() : '')

/** 真实人员行（排除表尾值班行、说明行、班次说明行） */
export function isPersonRow(row: ShiftRow | null | undefined, nc: NameCols): boolean {
  if (!row || typeof row !== 'object') return false
  const en = str(row, nc.eng), cn = str(row, nc.cn)
  const name = cn || en
  if (!name || isSummaryRow(name)) return false
  if (nc.eng && !isEnglishName(en)) return false
  if (cn && isShiftLikeName(cn)) return false
  return true
}
export const rowName = (row: ShiftRow, nc: NameCols): string => str(row, nc.cn) || str(row, nc.eng)

/** 取某人某天的班次（按完整日期，不同年份同月同日不会串） */
export function getDateShift(row: ShiftRow | null | undefined, y: number, m: number, d: number): string {
  if (!row) return ''
  let v = row[ymdKey(y, m, d)]
  if (v === undefined) v = row[`${m}月${d}日`]
  return String(v ?? '').trim()
}

export interface Person { cn: string; en: string; row: ShiftRow }
/** 候选名单：只认有英文名、且至少有一个日期格有值的真人行 */
export function listPeople(data: ShiftRow[]): Person[] {
  const out: Person[] = [], seen = new Set<string>()
  if (!data.length) return out
  const nc = resolveNameCols(data[0])
  for (const r of data) {
    if (!r || typeof r !== 'object') continue
    const cn = str(r, nc.cn), en = str(r, nc.eng)
    if (!isEnglishName(en)) continue
    if (cn && isShiftLikeName(cn)) continue
    const key = en.toLowerCase()
    if (seen.has(key)) continue
    const hasShift = Object.keys(r).some(k => (isYmdKey(k) || /月\d+日$/.test(k)) && String(r[k] ?? '').trim())
    if (!hasShift) continue
    seen.add(key)
    out.push({ cn, en, row: r })
  }
  return out
}
export type MatchHow = 'exact' | 'prefix' | 'contains'
/** 姓名识别：完全匹配 > 前缀 > 包含；同一层多人命中返回候选 */
export function matchPerson(people: Person[], q: string): { person: Person | null; how?: MatchHow; candidates: Person[] } {
  const ql = String(q ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!ql) return { person: null, candidates: [] }
  const lc = (s: string) => String(s ?? '').toLowerCase().replace(/\s+/g, '')
  const tiers: [MatchHow, (p: Person) => boolean][] = [
    ['exact', p => lc(p.cn) === ql || lc(p.en) === ql],
    ['prefix', p => (!!p.cn && lc(p.cn).startsWith(ql)) || (!!p.en && lc(p.en).startsWith(ql))],
    ['contains', p => (!!p.cn && lc(p.cn).includes(ql)) || (!!p.en && lc(p.en).includes(ql))]
  ]
  for (const [how, fn] of tiers) {
    const c = people.filter(fn)
    if (c.length === 1) return { person: c[0], how, candidates: c }
    if (c.length > 1) return { person: null, how, candidates: c }
  }
  return { person: null, candidates: [] }
}
export function findUserRow(data: ShiftRow[], user: string): ShiftRow | null {
  if (!user || !data.length) return null
  const nc = resolveNameCols(data[0]), u = user.toLowerCase()
  if (nc.eng) {
    for (const r of data) {
      const en = str(r, nc.eng)
      if (en && !isSummaryRow(en) && en.toLowerCase() === u) return r
    }
  }
  if (nc.cn) {
    for (const r of data) {
      const c = str(r, nc.cn)
      if (c && !isSummaryRow(c) && c.toLowerCase() === u) return r
    }
  }
  return null
}
export const personLabel = (p: { cn: string; en: string }): string => (p.cn && p.en ? `${p.cn}（${p.en}）` : p.cn || p.en)
