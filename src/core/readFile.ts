// 读 CSV / Excel → 行对象数组（单元格统一转字符串，Date 转 YYYY/M/D HH:mm:ss）
import { decodeText, formatTimeStamp, parseCSV } from './text'
import { loadXlsx } from './xlsx'
import { ymdKey } from './date'
import type { ShiftRow } from './shift'

export const ACCEPT = '.csv,.txt,.xlsx,.xls'
export function fileExt(name: string): string { return (name.split('.').pop() || '').toLowerCase() }
export function isSupported(name: string): boolean { return ['csv', 'txt', 'xlsx', 'xls'].includes(fileExt(name)) }

function stringifyRow(row: Record<string, unknown>): ShiftRow {
  const o: ShiftRow = {}
  for (const k of Object.keys(row)) {
    const v = row[k]
    o[k] = v === null || v === undefined ? '' : v instanceof Date ? formatTimeStamp(v, true) : String(v)
  }
  return o
}

export async function readTableFile(file: File): Promise<ShiftRow[]> {
  const ext = fileExt(file.name)
  if (!isSupported(file.name)) throw new Error('请上传 CSV 或 Excel 文件')
  if (ext === 'csv' || ext === 'txt') {
    const text = decodeText(await file.arrayBuffer())
    return parseCSV(text)
  }
  const XLSX = await loadXlsx()
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' }).map(stringifyRow)
}

/** 导入班表用：CSV 按纯文本、Excel 按工作表解析（填充合并单元格，日期型表头统一成 YYYY-MM-DD） */
export async function readTableFileAsSheet(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await loadXlsx()
  const ext = fileExt(file.name)
  const buf = await file.arrayBuffer()
  // CSV 一律按纯文本读：否则 SheetJS 会把表头 2026-11-21 识别成日期再输出成 11/21/26（日期列识别失败），
  // 且 ISO 日期按 UTC 解析，西半球时区会差一天；顺带保留 007 这类前导零
  const wb = ext === 'csv' || ext === 'txt'
    ? XLSX.read(decodeText(buf), { type: 'string', raw: true })
    : XLSX.read(new Uint8Array(buf), { type: 'array', cellNF: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  headerDatesToText(XLSX, ws, !!wb.Workbook?.WBProps?.date1904)   // 先换算，合并表头填充出去的才是文本
  fillMerges(XLSX, ws)
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false })
}

/**
 * Excel 表头里的日期型单元格 → 'YYYY-MM-DD' 文本。
 * 默认日期格式显示为 11/21/26，日期列识别不了；直接按 Excel 序列号换算年月日，不经过 JS Date，不受时区影响
 */
function headerDatesToText(XLSX: typeof import('xlsx-js-style'), ws: import('xlsx-js-style').WorkSheet, date1904: boolean): void {
  const ref = ws['!ref']
  if (!ref) return
  const range = XLSX.utils.decode_range(ref)
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })] as { t?: string; v?: unknown; w?: string; z?: unknown } | undefined
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number' || typeof cell.z !== 'string' || !XLSX.SSF.is_date(cell.z)) continue
    const serial = Math.abs(cell.v - Math.round(cell.v)) < 1 / 1440 ? Math.round(cell.v) : cell.v   // 部分软件写入时带几十秒误差
    const p = XLSX.SSF.parse_date_code(date1904 ? serial + 1462 : serial)   // 1904 日期系统：序列号整体少 1462 天 as { y: number; m: number; d: number } | null
    if (!p || !p.y) continue
    const s = ymdKey(p.y, p.m, p.d)
    cell.t = 's'; cell.v = s; cell.w = s; delete cell.z
  }
}

/** 合并单元格：把合并区域左上角的值填到区域内所有单元格（班表首行常是合并表头） */
function fillMerges(XLSX: typeof import('xlsx-js-style'), sheet: import('xlsx-js-style').WorkSheet): void {
  const merges = sheet['!merges']
  if (!merges) return
  for (const m of merges) {
    const addr = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })
    const cell = sheet[addr] as { v?: unknown } | undefined
    const val = cell ? cell.v : ''
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        const a = XLSX.utils.encode_cell({ r, c })
        if (!sheet[a]) (sheet as Record<string, unknown>)[a] = { t: 's', v: val }
        else if (r === m.s.r && c === m.s.c) continue
        else (sheet[a] as { v?: unknown }).v = val
      }
    }
  }
}

/** 导出 Excel（表头 + 列宽），字段值先清洗 */
export async function exportRows(rows: Record<string, unknown>[], columns: string[], fileName: string): Promise<void> {
  const XLSX = await loadXlsx()
  const { cleanText } = await import('./text')
  const aoa: unknown[][] = [columns.slice()]
  for (const r of rows) aoa.push(columns.map(c => (c ? cleanText(r[c] ?? '') : '')))
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = columns.map(c => {
    let max = c ? c.length : 10
    for (const r of rows) { const v = String(r[c] ?? ''); if (v.length > max) max = Math.min(v.length, 60) }
    return { wch: Math.max(max + 4, 12) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, fileName)
}
