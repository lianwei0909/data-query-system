import { describe, it, expect } from 'vitest'
import { classifyShift, isOnDuty, isPersonRow, resolveNameCols, getDateShift, listPeople, matchPerson } from '../src/core/shift'
import { computeStats, computeDayAttendance, computeOverview } from '../src/core/stats'

const ROWS = [
  { 企业名: 'alice(甲)', 英文名: 'alice', 中文名: '甲', '2026-11-16': '白班', '2026-11-17': '休', '2026-11-18': '年假' },
  { 企业名: 'bob(乙)', 英文名: 'bob', 中文名: '乙', '2026-11-16': '小夜班3', '2026-11-17': '白班' },
  { 企业名: 'carol(丙)', 英文名: 'carol', 中文名: '丙', '2026-11-16': '病假' },
  { 企业名: 'dave(丁)', 英文名: 'dave', 中文名: '丁', '2026-11-16': '休' },
  { 企业名: '', 英文名: '', 中文名: '争议白班值班', '2026-11-16': '甲' },
  { 企业名: '', 英文名: '', 中文名: '早班1', '2026-11-16': '9 - 18' }
]

describe('班次口径', () => {
  it('分类：白 / 夜 / 休 / 假', () => {
    expect(classifyShift('白班')?.k).toBe('day')
    expect(classifyShift('小夜班3')?.k).toBe('night')
    expect(classifyShift('休')?.k).toBe('rest')
    expect(classifyShift('病假')?.k).toBe('leave')
    expect(classifyShift('')).toBeNull()
  })
  it('病假 / 事假不算出勤（v1 统计卡会算进去）', () => {
    expect(isOnDuty('病假')).toBe(false)
    expect(isOnDuty('事假')).toBe(false)
    expect(isOnDuty('白班')).toBe(true)
  })
  it('表尾值班行、班次说明行不是人', () => {
    const nc = resolveNameCols(ROWS[0])
    expect(ROWS.filter(r => isPersonRow(r, nc)).map(r => r.英文名)).toEqual(['alice', 'bob', 'carol', 'dave'])
  })
  it('按完整日期取值，不同年份同月同日不串', () => {
    expect(getDateShift(ROWS[0], 2026, 11, 16)).toBe('白班')
    expect(getDateShift(ROWS[0], 2025, 11, 16)).toBe('')
  })
})

describe('统计卡与明细同一口径', () => {
  const today = new Date(2026, 10, 16)
  it('今日出勤人数 = 明细人数 = 2（甲白班 + 乙夜班）', () => {
    const s = computeStats(ROWS, 'alice', today)
    const att = computeDayAttendance(ROWS, 'alice', 2026, 11, 16)
    expect(s[1]).toMatchObject({ kind: 'num', value: 2 })
    expect(att.day.length + att.night.length).toBe(2)
  })
  it('值班人打徽章并排在最前', () => {
    const att = computeDayAttendance(ROWS, 'alice', 2026, 11, 16)
    expect(att.day[0]).toMatchObject({ name: '甲', duty: '白班值班', me: true })
  })
  it('没有数据时不编造数字', () => {
    const s = computeStats([], '', today)
    expect(s.slice(0, 3).every(x => x.kind === 'empty')).toBe(true)
    expect(s[3].kind).toBe('num')      // 发薪日与班表无关
  })
  it('距离休息：明天休息', () => {
    expect(computeStats(ROWS, 'alice', today)[2]).toMatchObject({ kind: 'special', label: '距离休息还有 1 天' })
  })
  it('本月概览按周期统计', () => {
    const o = computeOverview(ROWS[0], today)
    expect([o.day, o.rest, o.leave]).toEqual([1, 1, 1])
  })
})

describe('查看人识别', () => {
  const people = listPeople(ROWS)
  it('候选只含真人', () => expect(people.map(p => p.en)).toEqual(['alice', 'bob', 'carol', 'dave']))
  it('中文名完全匹配', () => expect(matchPerson(people, '乙').person?.en).toBe('bob'))
  it('前缀匹配', () => expect(matchPerson(people, 'car').person?.en).toBe('carol'))
  it('找不到', () => expect(matchPerson(people, 'zzz').person).toBeNull())
})
