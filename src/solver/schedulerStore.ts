// 排班页状态与持久化（从 v1 scheduler-core.js 页面层逐行移植的纯函数，存储可注入，便于单测）
// localStorage key 与 v1 完全一致：scheduler_people / scheduler_rules / scheduler_custom_need / scheduler_last
import SCH from './engine.js'
import { DAY, NIGHT, OFF, type CarryInfo, type NeedParse, type Person, type Rules, type ShiftCode } from './types'
import type { StorageLike } from '../core/storage'
import { resolveNameCols } from '../core/shift'

/** 需求识别结果 → 彩色标签（纯展示整理，不改 parseNeedText 的识别逻辑） */
export type NeedChipKind = 'leave' | 'off' | 'day' | 'night' | 'work' | 'prefer' | 'count' | 'bad'
export interface NeedChip { kind: NeedChipKind; text: string }
const CHIP_WEEK = ['日', '一', '二', '三', '四', '五', '六', '日']
function fmtNeedTok(tok: string): string {
  const [day, type] = String(tok).split(':')
  const m = day.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const label = m ? `${+m[2]}/${+m[3]}` : day
  return type ? `${label} ${type.replace('小夜班3', '夜班')}` : label
}
export function needChips(n: NeedParse | null | undefined): NeedChip[] {
  if (!n) return []
  const out: NeedChip[] = []
  n.leave.forEach(t => out.push({ kind: 'leave', text: fmtNeedTok(t) }))
  n.off.forEach(t => out.push({ kind: 'off', text: fmtNeedTok(t) }))
  n.fix.forEach(t => out.push({ kind: /夜/.test(t) ? 'night' : 'day', text: fmtNeedTok(t) }))
  n.work.forEach(t => out.push({ kind: 'work', text: fmtNeedTok(t) }))
  const week = (arr: number[], kind: NeedChipKind, label: string) => {
    if (arr && arr.length) out.push({ kind, text: '周' + arr.map(x => CHIP_WEEK[x] || '').join('') + label })
  }
  week(n.weekDay, 'day', '白班'); week(n.weekNight, 'night', '夜班')
  week(n.weekOff, 'off', '休'); week(n.weekWork, 'work', '上班')
  if (n.prefer) out.push({ kind: 'prefer', text: n.prefer === 'day' ? '偏白班' : '偏夜班' })
  if (n.target != null) out.push({ kind: 'count', text: `上班 ${n.target} 天` })
  ;(n.counts || []).forEach(c => out.push({ kind: 'count', text: `${c.kind === 'work' ? '上班' : c.kind === 'day' ? '白班' : c.kind === 'night' ? '夜班' : '合计'}${c.op === 'min' ? '≥' : c.op === 'max' ? '≤' : '='}${c.n}` }))
  ;(n.balance || []).forEach(b => out.push({ kind: 'prefer', text: `${b === 'night' ? '夜班' : b === 'day' ? '白班' : b === 'weekend' ? '周末班' : '出勤'}均分` }))
  if (n.dayAll) out.push({ kind: 'day', text: '全白班' })
  if (n.nightAll) out.push({ kind: 'night', text: '全夜班' })
  ;(n.invalid || []).forEach(t => out.push({ kind: 'bad', text: `没看懂：${t}` }))
  return out
}

export type Row = Record<string, unknown>
export const LS_PEOPLE = 'scheduler_people'
export const LS_RULES = 'scheduler_rules'
export const LS_CUSTOM = 'scheduler_custom_need'
export const LS_LAST = 'scheduler_last'
/** 旧版本曾预置过的一句固定需求；老存档里若还是这句原文，加载时清空 */
const OLD_DEFAULT_NEED = '周四周五白班，其余夜班'
export const CARRY_DAYS = 8

export function cnWeek(n: number | string): string {
  return ['', '一', '二', '三', '四', '五', '六', '日'][parseInt(String(n), 10)] || ''
}
/** 班表单元格 → 0 休/假 / 1 白 / 2 夜（正常班、早班2、白班都算白班；小夜班3、晚班算夜班），空 → null */
export function shiftCode(v: unknown): ShiftCode | null {
  const t = String(v == null ? '' : v).trim()
  if (!t) return null
  if (/(休|假|off|leave)/i.test(t)) return OFF
  if (/(夜|晚|night)/i.test(t)) return NIGHT
  return DAY
}
/** 列名是否为某一天：11月20日 / 11月20号 / 2026-11-20 / 2026/11/20 / 11/20 */
export function dateKeyMatch(key: string, d: Date): boolean {
  const k = String(key).trim(), y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate()
  let x: RegExpMatchArray | null
  if ((x = k.match(/^(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*[日号]?$/))) return +x[1] === y && +x[2] === m && +x[3] === dd
  if ((x = k.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/))) return +x[1] === m && +x[2] === dd
  if ((x = k.match(/^(\d{1,2})[\/.](\d{1,2})$/))) return +x[1] === m && +x[2] === dd
  return false
}

// ── 人员 ──
/** 往期习惯：最近 6 周里「休」落在星期几（周日=0）的次数，和最常用的白班写法（早班2 / 正常班 / 白班）。只看带年份的日期列 */
export function habitsOf(r: Row, dateKs: string[]): { restHist: number[]; dayLabel: string } {
  const restHist = [0, 0, 0, 0, 0, 0, 0], labels: Record<string, number> = {}
  const iso = dateKs.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && String(r[k] ?? '').trim()).sort()
  if (!iso.length) return { restHist, dayLabel: '' }
  const from = new Date(iso[iso.length - 1] + 'T00:00:00')
  from.setDate(from.getDate() - 41)
  for (const k of iso) {
    const d = new Date(k + 'T00:00:00')
    if (d < from) continue
    const v = String(r[k]).trim()
    if (v === '休') restHist[d.getDay()]++
    else if (shiftCode(v) === DAY) labels[v] = (labels[v] || 0) + 1
  }
  return { restHist, dayLabel: Object.keys(labels).sort((a, b) => labels[b] - labels[a])[0] || '' }
}
/** 从导入的班表提取人员：英文名 / 中文名 / 企业名，nightBias 按历史班表的夜班占比统计 */
export function peopleFromImported(rows: Row[]): Person[] {
  if (!Array.isArray(rows) || !rows.length) return []
  const keySet: Record<string, 1> = {}
  rows.forEach(r => { if (r && typeof r === 'object') Object.keys(r).forEach(k => { keySet[k] = 1 }) })
  const keys = Object.keys(keySet)
  const dateKs = keys.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) || /^\d{1,2}月\d{1,2}[日号]$/.test(k))
  const out: Person[] = [], seen: Record<string, 1> = {}
  rows.forEach(r => {
    if (!r || typeof r !== 'object') return
    // 姓名列逐行识别（与日历同一口径）：原来取「所有行列名的并集」里第一个带「英文」的列，
    // 旧格式行（列名 `排班原则…_1` / '' / _1）没有这一列，整行被跳过，排班名单里少人
    const nc = resolveNameCols(r)
    const orgK = Object.keys(r).find(k => k.includes('企业')) ?? null
    const en = nc.eng !== null ? String(r[nc.eng] || '').trim() : '', cn = nc.cn !== null ? String(r[nc.cn] || '').trim() : ''
    if (nc.eng !== null && !/^[A-Za-z][A-Za-z0-9._\- ]*$/.test(en)) return          // 表尾值班 / 说明行没有英文名
    if (cn && /(班|休|假|值班|备注|合计|出勤)\s*\d*$/.test(cn)) return
    const id = (en || cn).toLowerCase()
    if (!id || seen[id]) return
    let work = 0, night = 0
    dateKs.forEach(k => { const c = shiftCode(r[k]); if (c === DAY || c === NIGHT) { work++; if (c === NIGHT) night++ } })
    if (!work) return                                                    // 没有任何班次的行不是人
    seen[id] = 1
    out.push({
      en: en || cn, cn: cn || en, org: orgK !== null ? String(r[orgK] || '').trim() || (en || cn) : (en || cn),
      prefer: '', active: true, nightBias: Math.round(night / work * 100) / 100, need: '', ...habitsOf(r, dateKs)
    })
  })
  return out
}
/** 把班表里新出现的人加进现有名单（已有的人保留勾选状态和需求文字）；返回新增人数 */
export function syncPeopleFromImported(list: Person[], rows: Row[]): number {
  let added = 0
  peopleFromImported(rows).forEach(f => {
    const hit = list.find(x => String(x.en).toLowerCase() === String(f.en).toLowerCase())
    if (hit) {
      if (!hit.cn) hit.cn = f.cn
      if (!hit.org) hit.org = f.org
      if (typeof hit.nightBias !== 'number') hit.nightBias = f.nightBias
      hit.restHist = f.restHist                                          // 往期习惯每次按最新导入的班表重算
      if (f.dayLabel) hit.dayLabel = f.dayLabel
    } else { list.push(f); added++ }
  })
  return added
}
export function loadPeople(rows: Row[], ls: StorageLike): Person[] {
  try {
    const raw = ls.getItem(LS_PEOPLE)
    if (raw) {
      const list = JSON.parse(raw) as Person[]
      if (Array.isArray(list) && list.length) {
        list.forEach(p => {
          if (p.need === undefined) {                                    // 老存档只有 weekDay/weekNight，迁移成需求文字
            const txt: string[] = []
            if (p.weekDay) txt.push('周' + String(p.weekDay).split(',').map(cnWeek).join('') + '白班')
            if (p.weekNight) txt.push('周' + String(p.weekNight).split(',').map(cnWeek).join('') + '夜班')
            p.need = txt.join('，')
          }
          if (p.need === OLD_DEFAULT_NEED) p.need = ''
          p.prefer = ''                                                  // 偏好只来自需求文字
        })
        syncPeopleFromImported(list, rows)
        return list
      }
    }
  } catch { /* 存档损坏：按导入班表重新提取 */ }
  return peopleFromImported(rows)
}
export function savePeople(list: Person[], ls: StorageLike): void {
  try { ls.setItem(LS_PEOPLE, JSON.stringify(list)) } catch { /* 存储满 */ }
}
export function loadCustom(ls: StorageLike): string {
  try { return ls.getItem(LS_CUSTOM) || '' } catch { return '' }
}
export function saveCustom(text: string, ls: StorageLike): void {
  try { ls.setItem(LS_CUSTOM, text || '') } catch { /* 存储满 */ }
}

// ── 规则 ──
export function defaultRules(): Rules { return { ...SCH.DEFAULT_RULES } }
export function loadRules(ls: StorageLike): Rules {
  try {
    const raw = ls.getItem(LS_RULES)
    if (raw) {
      let r = JSON.parse(raw) as Partial<Rules> | null
      if (!r || r.v === undefined || r.v < 2) {                          // 旧存档「小夜=软约束」，升级为硬性要求
        r = r || {}
        r.nightToDayHard = true
        r.v = 2
        saveRules(r as Rules, ls)
      }
      return { ...defaultRules(), ...r }                                 // v2.1：缺字段的残缺存档用默认值补齐
    }
  } catch { /* 存档损坏 */ }
  return defaultRules()
}
export function saveRules(r: Rules, ls: StorageLike): void {
  try { ls.setItem(LS_RULES, JSON.stringify(r)) } catch { /* 存储满 */ }
}

// ── 跨周期衔接 ──
/** 从导入的实际班表里取上期最后 8 天（实际执行的班次比本工具上次生成的更可靠，优先使用） */
export function carryFromImported(rows: Row[], people: Person[], dates: Date[]): CarryInfo | null {
  if (!Array.isArray(rows) || !rows.length) return null
  const prevDays: Date[] = []
  for (let i = CARRY_DAYS; i >= 1; i--) { const d = new Date(dates[0].getTime()); d.setDate(d.getDate() - i); prevDays.push(d) }
  const keySet = new Set<string>()
  rows.forEach(r => { if (r && typeof r === 'object') Object.keys(r).forEach(k => keySet.add(k)) })
  const keys = [...keySet]                                               // 所有行的列并集：第一行可能是旧格式 / 只覆盖部分日期
  const colOf = prevDays.map(d => keys.find(k => dateKeyMatch(k, d)) ?? null)
  if (!colOf[colOf.length - 1]) return null                              // 导入的班表必须包含本期首日的前一天
  let found = 0
  const carry = people.map(p => {
    let row: Row | null = null
    for (let r = 0; r < rows.length && !row; r++) {
      const cur = rows[r]
      if (!cur || typeof cur !== 'object') continue
      const nc = resolveNameCols(cur)                                    // 姓名列逐行识别
      const orgK = Object.keys(cur).find(k => k.includes('企业')) ?? null
      for (const nk of [nc.eng, nc.cn, orgK]) {
        if (nk === null) continue
        const v = String(cur[nk] || '').trim()
        if (v && (v.toLowerCase() === String(p.en).toLowerCase() || v === p.cn || v === p.org)) { row = cur; break }
      }
    }
    if (!row) return [] as ShiftCode[]
    let seq: ShiftCode[] = []
    colOf.forEach(k => {
      const c = k ? shiftCode(row![k]) : null
      if (c === null) { seq = []; return }                                // 中间断档：只保留紧挨本期的连续几天
      seq.push(c)
    })
    if (seq.length) found++
    return seq
  })
  if (!found) return null
  const missing = people.filter((_, i) => !carry[i].length).map(p => p.cn)
  return { carry, linked: true, gap: 1, source: 'import', days: colOf.filter(Boolean).length, missing }
}
/** 间隔 1 天正常衔接；间隔 2~7 天视为有空档（空档按休息处理）；无存档或间隔 >7 天则不衔接 */
export function loadCarry(people: Person[], dates: Date[], rows: Row[], ls: StorageLike): CarryInfo {
  const none: CarryInfo = { carry: null, linked: false, gap: -1 }
  try { const imp = carryFromImported(rows, people, dates); if (imp) return imp } catch { /* 继续尝试上次排班 */ }
  try {
    const raw = ls.getItem(LS_LAST)
    if (!raw) return none
    const last = JSON.parse(raw) as { dates?: string[]; people?: { en: string }[]; raw?: ShiftCode[][] } | null
    if (!last || !last.raw || !last.dates || !last.people) return none
    const pk = String(last.dates[last.dates.length - 1]).split('-')
    const endPrev = new Date(+pk[0], +pk[1] - 1, +pk[2])                 // 按本地日期解析，避免 UTC 偏移
    const diff = Math.round((dates[0].getTime() - endPrev.getTime()) / 86400000)
    if (diff < 1 || diff > 7) return none
    const map: Record<string, number> = {}
    last.people.forEach((p, i) => { map[p.en] = i })
    const carry = people.map(p => {
      const i = map[p.en]
      if (i == null || !last.raw![i]) return [] as ShiftCode[]
      let tail = last.raw![i].slice(-Math.min(CARRY_DAYS, last.raw![i].length))
      if (diff > 1) tail = tail.concat(new Array<ShiftCode>(diff - 1).fill(OFF))
      return tail
    })
    return { carry, linked: true, gap: diff, source: 'last' }
  } catch { return none }
}
export function saveLast(dates: Date[], people: Person[], raw: ShiftCode[][], ls: StorageLike): void {
  try {
    ls.setItem(LS_LAST, JSON.stringify({ dates: dates.map(SCH.keyOf), people: people.map(p => ({ en: p.en, cn: p.cn })), raw }))
  } catch { /* 存储满 */ }
}

// ── 周期与文案 ──
/** 默认排下一个周期：21 号及以后排「下月 20 日结束」的周期 */
export function defaultPeriod(now: Date): { year: number; month: number } {
  let month = now.getDate() >= 21 ? now.getMonth() + 2 : now.getMonth() + 1
  let year = now.getFullYear()
  if (month > 12) { month -= 12; year += 1 }
  return { year, month }
}
export function yearOptions(now: Date): number[] {
  const y = now.getFullYear()
  return [y - 1, y, y + 1, y + 2]
}
export function periodLabel(dates: Date[]): string {
  const a = dates[0], b = dates[dates.length - 1]
  return a.getFullYear() + '年' + (a.getMonth() + 1) + '月' + a.getDate() + '日 ~ ' +
    b.getFullYear() + '年' + (b.getMonth() + 1) + '月' + b.getDate() + '日（共 ' + dates.length + ' 天）'
}
const pad = (n: number) => (n < 10 ? '0' + n : String(n))
export function exportFileName(dates: Date[]): string {
  const a = dates[0], b = dates[dates.length - 1]
  return '排班_' + a.getFullYear() + '-' + pad(a.getMonth() + 1) + '-' + pad(a.getDate()) + '_' + pad(b.getMonth() + 1) + '-' + pad(b.getDate()) + '.xlsx'
}
/** 排班完成提示文案 */
export function finishMessage(nErr: number, nSolo: number): { msg: string; type: 'success' | 'error' } {
  return {
    msg: nErr ? '排班完成，但有 ' + nErr + ' 项要求无法满足，详见校验报告'
      : (nSolo ? '排班完成：硬性要求全部满足，有 ' + nSolo + ' 处单休（已尽量避免）' : '排班完成，全部要求满足'),
    type: nErr ? 'error' : 'success'
  }
}
