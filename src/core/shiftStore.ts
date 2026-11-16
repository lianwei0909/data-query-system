// 班表存储：localStorage('importedShiftData')，与 v1 共用同一个 key，老用户数据无需迁移即可读取
import { reactive } from 'vue'
import { inferDateKeys, isYmdKey } from './date'
import type { ShiftRow } from './shift'

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
/** 行的人员标识：英文名优先，其次中文名 / 姓名、企业名 */
export function shiftRowKey(r: ShiftRow): string {
  if (!r || typeof r !== 'object') return ''
  const keys = Object.keys(r)
  const pick = (re: RegExp) => {
    for (const k of keys) if (re.test(k)) { const v = String(r[k] ?? '').trim(); if (v) return v }
    return ''
  }
  return (pick(/英文/) || pick(/中文|姓名/) || pick(/企业/)).toLowerCase()
}
const filled = (v: unknown) => String(v ?? '').trim() !== ''
/** 合并：同一个人按日期合并（同一天以新导入为准），旧数据的其他日期、其他人保留 */
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
