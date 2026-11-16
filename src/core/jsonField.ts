// 从「JSON 格式字符串 / 双编码 JSON / 非标准片段」里按 key 取值：v1 common.js 逻辑迁移
function decodeJsonEscapes(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case '"': return '"'
      case '\\': return '\\'
      case '/': return '/'
      default: return c
    }
  })
}
/** 转义感知的值扫描：普通引号 / 转义引号 / 无引号纯值 */
function scanValue(rest: string, start: number): string {
  if (rest[start] === '"') {
    let i = start + 1, buf = ''
    while (i < rest.length) {
      const c = rest[i]
      if (c === '\\') { buf += c + (rest[i + 1] || ''); i += 2; continue }
      if (c === '"') return buf
      buf += c; i++
    }
    return buf
  }
  if (rest[start] === '\\' && rest[start + 1] === '"') {
    let j = start + 2, buf = ''
    while (j < rest.length) {
      if (rest[j] === '\\' && rest[j + 1] === '"') return buf
      buf += rest[j]; j++
    }
    return buf
  }
  let k = start, buf = ''
  while (k < rest.length && ' \n\r\t;,}'.indexOf(rest[k]) === -1) { buf += rest[k]; k++ }
  return buf
}
export function extractFromStr(str: string | null | undefined, key: string): string | null {
  if (!str) return null
  try {
    const parsed = JSON.parse(str)
    if (parsed && typeof parsed === 'object' && key in parsed && parsed[key] != null) {
      return String(parsed[key]).replace(/[\n\r\t]+/g, ' ').trim() || null
    }
  } catch { /* 不是合法 JSON，走字符串扫描 */ }

  const doExtract = (s: string, quote: string): string | null => {
    const kw = quote + key + quote
    const idx = s.indexOf(kw)
    if (idx === -1) return null
    let rest = s.slice(idx + kw.length)
    let colon = -1
    for (let j = 0; j < rest.length; j++) if (rest[j] === ':' || rest[j] === ';') { colon = j; break }
    if (colon === -1) return null
    rest = rest.slice(colon + 1)
    let vs = 0
    while (vs < rest.length && (rest[vs] === ' ' || rest[vs] === '\t')) vs++
    if (vs >= rest.length) return null
    const raw = scanValue(rest, vs).replace(/[\n\r\t]+/g, ' ').trim()
    return raw ? decodeJsonEscapes(raw) : null
  }
  return doExtract(str, '"') || doExtract(str, '\\"')
}
