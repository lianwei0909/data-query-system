// CSV 解析、编码识别、时间格式化：由 v1 common.js 迁移（逻辑逐行对照，含 Excel 序列号时区修正）

/** 去 BOM，CSV 逐字符状态机（正确处理引号内换行与逗号） */
export function parseCSV(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false, i = 0
  const pushRow = () => { row.push(field); field = ''; if (row.some(f => f && f.trim())) rows.push(row); row = [] }
  while (i <= text.length) {
    if (i === text.length) {
      if (field || row.length) { row.push(field); if (row.some(f => f && f.trim())) rows.push(row) }
      break
    }
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\n') { pushRow(); i++; continue }
    field += ch; i++
  }
  if (rows.length < 2) return []
  const headers = rows[0].map(h => { let s = h || ''; if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1); return s.trim() })
  const out: Record<string, string>[] = []
  for (let ri = 1; ri < rows.length; ri++) {
    const obj: Record<string, string> = {}
    headers.forEach((h, j) => { obj[h] = (rows[ri][j] || '').replace(/\t/g, ' ').trim() })
    out.push(obj)
  }
  return out
}

/** 优先 UTF-8（严格），不合法则按 GBK（中文 Windows 版 Excel 另存的 CSV） */
export function decodeText(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* 非 UTF-8 */ }
  try { return new TextDecoder('gbk').decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n
/** Excel 序列号 → 本地年月日时分秒（UTC 构造、UTC 读取，避免 +8 小时偏移） */
export function excelSerialToParts(serial: string | number): { y: number; m: number; d: number; hh: number; mm: number; ss: number } | null {
  const n = parseFloat(String(serial))
  if (!isFinite(n)) return null
  let days = Math.floor(n)
  let secs = Math.round((n - days) * 86400)
  if (secs >= 86400) { days += 1; secs -= 86400 }
  const d = new Date((days - 25569) * 86400000)
  if (isNaN(d.getTime())) return null
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: Math.floor(secs / 3600), mm: Math.floor((secs % 3600) / 60), ss: secs % 60 }
}
/** 统一为 YYYY/M/D[ HH:mm:ss] */
export function formatTimeStamp(ts: unknown, keepTime = false): string {
  if (ts === null || ts === undefined || ts === '') return ''
  if (ts instanceof Date) {
    if (isNaN(ts.getTime())) return ''
    const base = `${ts.getFullYear()}/${ts.getMonth() + 1}/${ts.getDate()}`
    return keepTime ? `${base} ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}:${pad2(ts.getSeconds())}` : base
  }
  const s = String(ts).replace(/\t/g, ' ').trim()
  if (/^\d+(\.\d+)?$/.test(s) && s.length <= 12) {
    const p = excelSerialToParts(s)
    if (!p) return s
    const r0 = `${p.y}/${p.m}/${p.d}`
    return keepTime ? `${r0} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}` : r0
  }
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (m) {
    let r = `${m[1]}/${parseInt(m[2])}/${parseInt(m[3])}`
    if (keepTime) {
      const t = s.slice(m[0].length).trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/)
      if (t) r += ` ${t[1].padStart(2, '0')}:${t[2].padStart(2, '0')}:${(t[3] || '00').padStart(2, '0')}`
    }
    return r
  }
  return s
}

/** 去换行 / 制表 / 字面量 \n 残留 */
export function cleanText(v: unknown): string {
  return String(v ?? '').replace(/[\n\r\t]+/g, ' ').replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ').replace(/\s{2,}/g, ' ').trim()
}
