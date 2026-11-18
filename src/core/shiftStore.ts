// 班表存储：localStorage('importedShiftData')，与 v1 共用同一个 key，老用户数据无需迁移即可读取
import { reactive } from 'vue'
import { inferDateKeys, isYmdKey } from './date'
import { resolveNameCols, type ShiftRow } from './shift'

export const SHIFT_KEY = 'importedShiftData'

/** 把一组行的日期列名改写成 YYYY-MM-DD（旧版「X月X日」数据迁移、导入时统一调用） */
export function normalizeShiftRows(rows: ShiftRow[], refDate?: Date): { rows: ShiftRow[]; changed: boolean } {
  if (!Array.isArray(rows) || !rows.length) return { rows: rows || [], changed: false }
  const all = new Set<string>()
  rows.forEach(r => { if (r && typeof r === 'object') Object.keys(r).forEach(k => all.add(k)) })
  const keys = [...all]
  const map = inferDateKeys(keys, refDate)
  if (!keys.some(k => map[k] && map[k] !== k)) return { rows, changed: false }
  return {
    changed: true,
    rows: rows.map(r => {
      if (!r || typeof r !== 'object') return r
      const n: ShiftRow = {}
      for (const k of Object.keys(r)) {
        const nk = map[k] || k
        if (n[nk] === undefined || String(n[nk]).trim() === '') n[nk] = r[k]
      }
      return n
    })
  }
}
/**
 * 行的人员标识：英文名优先，其次中文名、企业名。
 * 姓名列按「这一行」识别（与日历查人同一口径）：旧版本存档 / 两行表头按通用解析的行，列名是 `排班原则…_1`、`''`、`_1`，
 * 原来只认列名里带「英文 / 中文 / 企业」，这些行取不到标识，合并时被整行丢弃，新旧两种写法的同一个人也合不到一起。
 */
export function shiftRowKey(r: ShiftRow): string {
  if (!r || typeof r !== 'object') return ''
  const nc = resolveNameCols(r)
  const val = (k: string | null) => (k !== null ? String(r[k] ?? '').trim() : '')
  const org = Object.keys(r).find(k => k.includes('企业'))
  return (val(nc.eng) || val(nc.cn) || val(org ?? null)).toLowerCase()
}
const filled = (v: unknown) => String(v ?? '').trim() !== ''
/**
 * 合并：同一个人按日期合并（同一天以新导入为准），旧数据的其他日期、其他人保留。
 * 新旧行列名不同（旧行 `排班原则…_1`，新行 `英文名`）时，合并后的行改用新行的标准姓名列，避免一行里两套姓名列。
 * 识别不出人员的行：旧数据里的跳过、新文件里的作为独立行保留（与原逻辑一致）；
 * 旧格式行现在能按内容识别出人员，不会再落到这一分支被丢弃。
 */
export function mergeShiftRows(oldRows: ShiftRow[], newRows: ShiftRow[]): ShiftRow[] {
  const out: ShiftRow[] = [], idx = new Map<string, number>()
  for (const r of oldRows || []) {
    const k = shiftRowKey(r)
    if (!k) continue
    idx.set(k, out.length); out.push({ ...r })
  }
  for (const r of newRows || []) {
    const k = shiftRowKey(r)
    const at = k ? idx.get(k) : undefined
    if (at !== undefined) {
      const cur = out[at]
      const ncNew = resolveNameCols(r), ncOld = resolveNameCols(cur)
      const std = ncNew.eng !== null && ncNew.eng.includes('英文')
      if (std && !(ncOld.eng !== null && ncOld.eng.includes('英文'))) {
        // 旧行是非标准列名：去掉旧姓名列（含企业名列），由新行的标准列补上
        for (const c of [ncOld.eng, ncOld.cn]) if (c !== null) delete cur[c]
        for (const c of Object.keys(cur)) if (!isYmdKey(c) && /^(排班原则|班则)/.test(c)) delete cur[c]
      }
      for (const f of Object.keys(r)) if (filled(r[f])) cur[f] = r[f]
    } else {
      if (k) idx.set(k, out.length)
      out.push({ ...r })
    }
  }
  return out
}
export function shiftDateRange(rows: ShiftRow[]): { from: string; to: string; days: number } | null {
  const ks = new Set<string>()
  rows.forEach(r => r && Object.keys(r).forEach(k => { if (isYmdKey(k)) ks.add(k) }))
  const list = [...ks].sort()
  return list.length ? { from: list[0], to: list[list.length - 1], days: list.length } : null
}
/** 真正填了班次的日期范围：只有列名、整列为空的日期不算（给用户看的提示用这个口径） */
export function shiftFilledRange(rows: ShiftRow[]): { from: string; to: string; days: number } | null {
  const ks = new Set<string>()
  rows.forEach(r => r && Object.keys(r).forEach(k => {
    if (isYmdKey(k) && String(r[k] ?? '').trim()) ks.add(k)
  }))
  const list = [...ks].sort()
  return list.length ? { from: list[0], to: list[list.length - 1], days: list.length } : null
}

// ── 响应式存储：任何页面导入后，日历等页面自动刷新 ──
export const shiftState = reactive({ rows: [] as ShiftRow[], version: 0 })

export function loadShiftRows(): ShiftRow[] {
  let raw: string | null = null
  try { raw = localStorage.getItem(SHIFT_KEY) } catch { /* 隐私模式 */ }
  let data: ShiftRow[] = []
  if (raw) { try { data = JSON.parse(raw) } catch { data = [] } }
  if (!Array.isArray(data)) data = []
  const norm = normalizeShiftRows(data)
  if (norm.changed) {
    data = norm.rows
    try { localStorage.setItem(SHIFT_KEY, JSON.stringify(data)) } catch { /* 写回失败不影响读取 */ }
  }
  shiftState.rows = data
  shiftState.version++
  return data
}
/** 合并写入；超出存储限制时抛出 QuotaExceededError */
export function importShiftRows(newRows: ShiftRow[]): { merged: ShiftRow[]; hadOld: boolean } {
  const old = loadShiftRows()
  const merged = mergeShiftRows(old, normalizeShiftRows(newRows).rows)
  localStorage.setItem(SHIFT_KEY, JSON.stringify(merged))
  shiftState.rows = merged
  shiftState.version++
  return { merged, hadOld: old.length > 0 }
}

// ── 导入前差异预览：与 mergeShiftRows 同一套匹配规则（同一个人按日期合并，新文件里的空格不清空旧值） ──
export interface ShiftChange { person: string; date: string; from: string; to: string }
export interface ShiftDiff {
  /** 新文件里有、现有班表里没有的人 */
  newPeople: string[]
  /** 已有人员的空白日期被填上的格数（含新日期） */
  added: number
  /** 已有班次被改成另一个班次的明细（按日期、人员排序） */
  changed: ShiftChange[]
  /** 与现有班表完全相同的格数 */
  unchanged: number
  /** 新文件里识别不出人员（没有英文名 / 中文名 / 企业名）的行数，这些行导入后无法按人合并 */
  unnamed: number
  /** 新文件覆盖的日期范围 */
  range: { from: string; to: string; days: number } | null
  /** 其中现有班表里还没有任何班次的日期数 */
  newDates: number
}
const cellText = (v: unknown) => String(v ?? '').trim()
/** 人员显示名：中文名（英文名） */
export function shiftRowLabel(r: ShiftRow): string {
  const nc = resolveNameCols(r || {})
  const val = (k: string | null) => (k !== null ? cellText(r[k]) : '')
  const cn = val(nc.cn), en = val(nc.eng)
  const org = Object.keys(r || {}).find(k => k.includes('企业'))
  return cn && en && cn !== en ? `${cn}（${en}）` : (cn || en || val(org ?? null))
}
export function diffShiftRows(oldRows: ShiftRow[], newRows: ShiftRow[]): ShiftDiff {
  const old = new Map<string, ShiftRow>()
  const oldDates = new Set<string>()
  for (const r of oldRows || []) {
    const k = shiftRowKey(r)
    if (!k) continue
    old.set(k, { ...(old.get(k) || {}), ...r })
    Object.keys(r).forEach(f => { if (isYmdKey(f) && cellText(r[f])) oldDates.add(f) })   // 整列为空的日期不算已有
  }
  const out: ShiftDiff = { newPeople: [], added: 0, changed: [], unchanged: 0, unnamed: 0, range: shiftDateRange(newRows || []), newDates: 0 }
  const seenNew = new Set<string>()
  for (const r of newRows || []) {
    const k = shiftRowKey(r)
    if (!k) { out.unnamed++; continue }
    const o = old.get(k)
    if (!o) {
      if (!seenNew.has(k)) { seenNew.add(k); out.newPeople.push(shiftRowLabel(r)) }
      continue
    }
    for (const f of Object.keys(r)) {
      if (!isYmdKey(f)) continue
      const to = cellText(r[f])
      if (!to) continue                                  // 空格不会清空旧值
      const from = cellText(o[f])
      if (!from) out.added++
      else if (from === to) out.unchanged++
      else out.changed.push({ person: shiftRowLabel(o) || shiftRowLabel(r), date: f, from, to })
    }
  }
  if (out.range) {
    const s = new Set<string>()
    for (const r of newRows) Object.keys(r || {}).forEach(f => { if (isYmdKey(f) && cellText(r[f]) && !oldDates.has(f)) s.add(f) })
    out.newDates = s.size
  }
  out.changed.sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person, 'zh'))
  return out
}
/** 整体替换班表（撤销导入用）；超出存储限制时抛出 QuotaExceededError */
export function replaceShiftRows(rows: ShiftRow[]): void {
  localStorage.setItem(SHIFT_KEY, JSON.stringify(rows))
  shiftState.rows = rows
  shiftState.version++
}

// ── 跨标签页同步：别的标签页导入 / 撤销 / 改查看人后，停留在首页的标签也要立刻刷新 ──
// 同一标签页内的写入不触发 storage 事件（由 importShiftRows / replaceShiftRows 直接更新 shiftState）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if ((e.key === SHIFT_KEY || e.key === 'viewer_name') && e.newValue !== e.oldValue) loadShiftRows()
  })
}
