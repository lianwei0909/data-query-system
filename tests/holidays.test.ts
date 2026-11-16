import { describe, it, expect } from 'vitest'
import { isWorkday, nextPayday, holidayYear } from '../src/core/holidays'
const f = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

describe('节假日与调休', () => {
  it('国庆放假、周六补班', () => {
    expect(isWorkday(new Date(2026, 9, 1))).toBe(false)
    expect(isWorkday(new Date(2026, 9, 10))).toBe(true)
  })
  it('未配置年份只按周末', () => {
    expect(holidayYear(2027)).toBeNull()
    expect(isWorkday(new Date(2027, 0, 1))).toBe(true)      // 周五，未配置元旦
    expect(isWorkday(new Date(2027, 0, 2))).toBe(false)     // 周六
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
})
