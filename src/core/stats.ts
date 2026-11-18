// 首页统计卡与概览的纯计算（无 DOM，便于单元测试）
import { addDays, periodOf, daysBetween } from './date'
import { holidayYear, nextPayday } from './holidays'
import { classifyShift, findUserRow, getDateShift, isOffDay, isOnDuty, isPersonRow, resolveNameCols, type ShiftKind, type ShiftRow } from './shift'

export type Stat =
  | { kind: 'num'; value: number; unit: string; label: string; tip?: string }
  | { kind: 'special'; text: string; label: string }
  | { kind: 'empty'; label: string; hint: string }

export function computeStats(data: ShiftRow[], viewer: string, today: Date): Stat[] {
  const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate()
  const userRow = data.length ? findUserRow(data, viewer) : null
  const noUser = !data.length ? '未导入班表' : !viewer ? '未选择查看人' : '班表中无此人'
  const out: Stat[] = []

  // ① 本月出勤天数：排班周期起始日截至今天，只计白班 / 夜班
  if (userRow) {
    const { start } = periodOf(today)
    let n = 0
    for (let c = start; c <= today; c = addDays(c, 1)) if (isOnDuty(getDateShift(userRow, c.getFullYear(), c.getMonth() + 1, c.getDate()))) n++
    out.push({ kind: 'num', value: n, unit: '天', label: '本月出勤天数', tip: `统计周期：${start.getMonth() + 1}/${start.getDate()} 起，休息和请假不计入` })
  } else out.push({ kind: 'empty', label: '本月出勤天数', hint: noUser })

  // ② 今日出勤人数：与「当日出勤」明细同一口径
  if (data.length) {
    const present = data.filter(r => isPersonRow(r, resolveNameCols(r)) && isOnDuty(getDateShift(r, y, m, d))).length
    out.push({ kind: 'num', value: present, unit: '人', label: '今日出勤人数' })
  } else out.push({ kind: 'empty', label: '今日出勤人数', hint: '未导入班表' })

  // ③ 距离休息
  if (!userRow) out.push({ kind: 'empty', label: '距离休息还有', hint: noUser })
  else if (isOffDay(getDateShift(userRow, y, m, d))) out.push({ kind: 'special', text: '要好好休息喔~', label: '今天休息' })
  else {
    let left: number | null = null
    for (let k = 1; k <= 31; k++) {
      const nd = addDays(today, k)
      if (isOffDay(getDateShift(userRow, nd.getFullYear(), nd.getMonth() + 1, nd.getDate()))) { left = k; break }
    }
    if (left === 1) out.push({ kind: 'special', text: '明天就休息啦！！！', label: '距离休息还有 1 天' })
    else if (left === null) out.push({ kind: 'empty', label: '距离休息还有', hint: '后续班表未排' })
    else out.push({ kind: 'num', value: left, unit: '天', label: '距离休息还有' })
  }

  // ④ 距离发薪日（与班表无关）
  const pay = nextPayday(today)
  const left = daysBetween(today, pay)
  const configured = !!holidayYear(pay.getFullYear())
  const tip = `发薪日：${pay.getMonth() + 1}月${pay.getDate()}日` + (configured ? '' : `（${pay.getFullYear()} 年法定节假日未配置，仅按周末推算）`)
  if (left <= 0) out.push({ kind: 'special', text: '首富已上位~有钱！消费！', label: '今天发窝囊废' })
  else if (left === 1) out.push({ kind: 'special', text: '明天就发赈灾粮啦！', label: '距离发窝囊废还有 1 天' })
  else out.push({ kind: 'num', value: left, unit: '天', label: '距离发窝囊废还有' + (configured ? '' : ' *'), tip })
  return out
}

export interface DayAttendance {
  day: { name: string; shift: string; me: boolean; duty?: string }[]
  night: { name: string; shift: string; me: boolean; duty?: string }[]
  dutyMiss: string[]
}
/** 当日出勤明细：按白 / 夜分组，表尾「争议白班值班 / 争议夜班值班」行标记值班人 */
export function computeDayAttendance(data: ShiftRow[], viewer: string, y: number, m: number, d: number): DayAttendance {
  const res: DayAttendance = { day: [], night: [], dutyMiss: [] }
  if (!data.length) return res
  const v = viewer.toLowerCase()
  const val = (r: ShiftRow, k: string | null) => (k !== null ? String(r[k] ?? '').trim() : '')
  const nameOf = (r: ShiftRow) => { const nc = resolveNameCols(r); return val(r, nc.cn) || val(r, nc.eng) }
  for (const r of data) {
    const nc = resolveNameCols(r)                // 逐行识别：存储里新旧格式的行会混在一起
    if (!isPersonRow(r, nc)) continue
    const s = getDateShift(r, y, m, d)
    if (!isOnDuty(s)) continue
    const name = nameOf(r), en = val(r, nc.eng)
    const p = { name, shift: s, me: !!v && (en.toLowerCase() === v || name.toLowerCase() === v) }
    if (classifyShift(s)!.k === 'night') res.night.push(p); else res.day.push(p)
  }
  let dayDuty = '', nightDuty = ''
  for (const r of data) {
    if (!r || typeof r !== 'object') continue
    const n = nameOf(r)
    if (n.includes('白班值班') || n.includes('争议白班')) dayDuty = getDateShift(r, y, m, d)
    if (n.includes('夜班值班') || n.includes('争议夜班')) nightDuty = getDateShift(r, y, m, d)
  }
  const mark = (who: string, label: string) => {
    if (!who) return
    const p = [...res.day, ...res.night].find(x => x.name === who)
    if (p) p.duty = p.duty ? `${p.duty} / ${label}` : label
    else res.dutyMiss.push(`${label}：${who}`)
  }
  mark(dayDuty, '白班值班'); mark(nightDuty, '夜班值班')
  const byDuty = (a: { duty?: string }, b: { duty?: string }) => (b.duty ? 1 : 0) - (a.duty ? 1 : 0)
  res.day.sort(byDuty); res.night.sort(byDuty)
  return res
}

/** 本月概览：当前排班周期内白 / 夜 / 休 / 假天数 */
export function computeOverview(row: ShiftRow, today: Date): Record<ShiftKind, number> & { start: Date; end: Date } {
  const { start, end } = periodOf(today)
  const cnt = { day: 0, night: 0, rest: 0, leave: 0 }
  for (let c = start; c <= end; c = addDays(c, 1)) {
    const k = classifyShift(getDateShift(row, c.getFullYear(), c.getMonth() + 1, c.getDate()))
    if (k) cnt[k.k]++
  }
  return { ...cnt, start, end }
}
