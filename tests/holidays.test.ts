import { describe, it, expect } from 'vitest'
import { isWorkday, nextPayday, holidayYear } from '../src/core/holidays'
const f = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

describe('节假日与调休', () => {
  it('国庆放假、周六补班', () => {
    expect(isWorkday(new Date(2026, 9, 1))).toBe(false)
    expect(isWorkday(new Date(2026, 9, 10))).toBe(true)
  })
  it('未配置年份只按周末', () => {
    expect(holidayYear(2028)).toBeNull()
    expect(isWorkday(new Date(2028, 0, 3))).toBe(true)      // 周一，未配置任何节假日
    expect(isWorkday(new Date(2028, 0, 1))).toBe(false)     // 周六
  })
  it('2027（国办发明电〔2026〕10号）：放假与周末调休补班', () => {
    expect(holidayYear(2027)!.off.length).toBe(29)
    const off = [[0, 1], [1, 5], [1, 12], [3, 5], [4, 3], [5, 9], [8, 15], [9, 7]]
    const work = [[0, 31], [1, 14], [4, 8], [8, 26], [9, 9]]           // 均为周末补班
    off.forEach(([m, d]) => expect(isWorkday(new Date(2027, m, d))).toBe(false))
    work.forEach(([m, d]) => {
      expect([0, 6]).toContain(new Date(2027, m, d).getDay())
      expect(isWorkday(new Date(2027, m, d))).toBe(true)
    })
  })
})

describe('发薪日（每月 5 号，遇节假日提前）', () => {
  it('4/5 周日+清明 → 提前到 4/3', () => {
    expect(f(nextPayday(new Date(2026, 3, 2)))).toBe('2026-4-3')
    expect(f(nextPayday(new Date(2026, 3, 3)))).toBe('2026-4-3')
  })
  it('提前发薪后、5 号之前：取下个月（v1 会算出负数显示「今天发」）', () => {
    expect(f(nextPayday(new Date(2026, 3, 4)))).toBe('2026-4-30')   // 5/1-5/5 放假，5 月发薪提前到 4/30
  })
  it('12/5 周六 → 12/4', () => {
    expect(f(nextPayday(new Date(2026, 10, 16)))).toBe('2026-12-4')
  })
  it('2027：春节 2/5、劳动节 5/5、国庆 10/5 均提前到节前最后一个工作日', () => {
    expect(f(nextPayday(new Date(2027, 0, 20)))).toBe('2027-2-4')
    expect(f(nextPayday(new Date(2027, 3, 10)))).toBe('2027-4-30')
    expect(f(nextPayday(new Date(2027, 8, 20)))).toBe('2027-9-30')
  })
})
