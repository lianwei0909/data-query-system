import type { Page } from '@playwright/test'

/** 固定「今天」= 2026-11-21：排班默认取当前周期 2026-11-21 ~ 2026-12-20，日历月份为 2026-11 */
export const NOW = new Date('2026-11-21T10:00:00+08:00')
export const PEOPLE: [string, string][] = [
  ['alice', '张一'], ['bob', '李二'], ['carol', '王三'], ['dave', '赵四'], ['erin', '钱五'], ['frank', '孙六'], ['gina', '周七']
]
const PATTERN = ['白班', '白班', '小夜班3', '小夜班3', '休', '休']
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 7 人往期班表 2026-09-21 ~ 2026-11-20（覆盖本月日历与排班的上期衔接） */
export function shiftRows(edit?: (row: Record<string, string>, i: number) => void): Record<string, string>[] {
  return PEOPLE.map(([en, cn], i) => {
    const r: Record<string, string> = { 企业名: en + '_corp', 英文名: en, 中文名: cn }
    for (let d = new Date(2026, 8, 21), k = 0; d <= new Date(2026, 10, 20); d.setDate(d.getDate() + 1), k++) r[ymd(d)] = PATTERN[(k + i) % 6]
    edit?.(r, i)
    return r
  })
}
export function toCsv(rows: Record<string, string>[]): string {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))]
  return '\ufeff' + [cols.join(','), ...rows.map(r => cols.map(c => r[c] ?? '').join(','))].join('\n')
}

/** 打开页面（固定时间、收集报错）；setup 在页面脚本执行前写入 localStorage */
export async function open(page: Page, path = './', setup?: Record<string, string>): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  page.on('console', m => { if (m.type() === 'error' && !/highs\.js|ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()) })
  await page.clock.setFixedTime(NOW)
  if (setup) await page.addInitScript(s => { if (!sessionStorage.getItem('__seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1') } }, setup)
  await page.goto(path)
  return errors
}

/**
 * 页面内计算文字对比度：文字色与「逐层叠加后的实际背景色」比较，返回不达标的元素（AA：普通 4.5，大字 3）。
 * 背景是渐变时取所有色标里最差的一个；纯 emoji / 符号的文本不参与（颜色不由 color 决定）
 */
export function contrastOffenders(page: Page, selector: string): Promise<{ sel: string; text: string; ratio: number; need: number }[]> {
  return page.evaluate(sel => {
    const parse = (c: string) => { const m = c.match(/[\d.]+/g) || ['0', '0', '0', '0']; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]] }
    const over = (fg: number[], bg: number[]) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
    const lum = (c: number[]) => { const v = c.slice(0, 3).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] }
    /** 从元素往上收集背景层：纯色层，或渐变层（多个候选色）；遇到不透明层停止 */
    const bgsOf = (el: Element | null): number[][] => {
      const chain: number[][][] = []
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        const stops = cs.backgroundImage.includes('gradient') ? (cs.backgroundImage.match(/rgba?\([^)]*\)/g) || []).map(parse) : []
        if (stops.length) { chain.push(stops); if (stops.every(s => s[3] >= 1)) break }
        const b = parse(cs.backgroundColor)
        if (b[3] > 0) { chain.push([b]); if (b[3] >= 1) break }
      }
      let acc = [parse(getComputedStyle(document.documentElement).backgroundColor)]
      if (acc[0][3] < 1) acc = [over(acc[0], [255, 255, 255, 1])]
      for (let i = chain.length - 1; i >= 0; i--) acc = acc.flatMap(a => chain[i].map(layer => over(layer, a)))
      return acc
    }
    const out: { sel: string; text: string; ratio: number; need: number }[] = []
    document.querySelectorAll(sel).forEach(el => {
      const own = [...el.childNodes].some(n => n.nodeType === 3 && /[\p{L}\p{N}]/u.test(n.textContent!))
      const r = (el as HTMLElement).getBoundingClientRect()
      if (!own || !r.width || !r.height) return
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || +cs.opacity < 0.6) return          // 半透明的「未参与」行不算
      let ratio = Infinity
      for (const bg of bgsOf(el)) {
        const fg = over(parse(cs.color), bg)
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
        ratio = Math.min(ratio, Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100)
      }
      const px = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700
      const need = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5
      if (ratio < need) out.push({ sel: el.tagName.toLowerCase() + '.' + [...el.classList].join('.'), text: (el.textContent || '').trim().slice(0, 24), ratio, need })
    })
    return out
  }, selector)
}
