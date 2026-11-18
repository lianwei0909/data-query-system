// 班次口径（全站唯一来源）：统计卡、出勤明细、日历标注、本月概览、候选名单都调用这里
import { isYmdKey, parseDateKey, ymdKey } from './date'

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
/**
 * 姓名列（按「这一行」判断，不要拿第一行代表整张表：存储里新旧格式的行会混在一起）。
 * ① 有「英文名 / 中文名 / 姓名」列名就用列名；
 * ② 没有列名时（两行表头按通用解析、旧版本存档，列名是 `排班原则…_1`、`''`、`_1`、`__EMPTY_1` 之类）按单元格内容认：
 *    日期列之前第一个「英文名样式」的值是英文名，最后一个非英文的非空值是中文名。
 * 列名可能是空字符串 ''（表头单元格为空串时 SheetJS 会这样命名），所以「没找到」一律用 null 表示，不能用真假判断。
 */
export function resolveNameCols(sample: ShiftRow | undefined): NameCols {
  if (!sample || typeof sample !== 'object') return { cn: null, eng: null }
  const keys = Object.keys(sample)
  let eng: string | null = keys.find(k => k.includes('英文')) ?? null
  let cn: string | null = keys.find(k => k.includes('中文')) ?? keys.find(k => k.includes('姓名')) ?? null
  if (eng !== null && cn !== null) return { cn, eng }
  const firstDate = keys.findIndex(k => !!parseDateKey(k))
  const head = firstDate < 0 ? keys : keys.slice(0, firstDate)
  const val = (k: string) => String(sample[k] ?? '').trim()
  if (eng === null) eng = head.find(k => isEnglishName(val(k))) ?? null
  if (cn === null) for (const k of head) if (k !== eng && val(k) && !isEnglishName(val(k))) cn = k
  return { cn, eng }
}
const str = (row: ShiftRow, col: string | null): string => (col !== null ? String(row[col] ?? '').trim() : '')

/** 真实人员行（排除表尾值班行、说明行、班次说明行） */
export function isPersonRow(row: ShiftRow | null | undefined, nc: NameCols): boolean {
  if (!row || typeof row !== 'object') return false
  const en = str(row, nc.eng), cn = str(row, nc.cn)
  const name = cn || en
  if (!name || isSummaryRow(name)) return false
  if (nc.eng !== null && !isEnglishName(en)) return false
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
  for (const r of data) {
    if (!r || typeof r !== 'object') continue
    const nc = resolveNameCols(r)                // 逐行识别：第一行可能是旧格式 / 表头残留
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
const filledDays = (r: ShiftRow): number => Object.keys(r).filter(k => isYmdKey(k) && String(r[k] ?? '').trim()).length
export function findUserRow(data: ShiftRow[], user: string): ShiftRow | null {
  if (!user || !data.length) return null
  const u = user.toLowerCase()
  const rows = data.filter(r => r && typeof r === 'object')
  const ncs = rows.map(r => resolveNameCols(r))   // 逐行识别姓名列
  // 先按英文名、再按中文名找；同名多行时取有班次最多的那一行（旧格式残留行通常只有很少几天）
  const best = (hits: ShiftRow[]) => hits.length < 2 ? hits[0] ?? null
    : hits.reduce((a, b) => (filledDays(b) > filledDays(a) ? b : a))
  const byEn = rows.filter((r, i) => { const en = str(r, ncs[i].eng); return !!en && !isSummaryRow(en) && en.toLowerCase() === u })
  if (byEn.length) return best(byEn)
  const byCn = rows.filter((r, i) => { const c = str(r, ncs[i].cn); return !!c && !isSummaryRow(c) && c.toLowerCase() === u })
  return best(byCn)
}
export const personLabel = (p: { cn: string; en: string }): string => (p.cn && p.en ? `${p.cn}（${p.en}）` : p.cn || p.en)
