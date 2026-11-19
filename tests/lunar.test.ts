import { describe, expect, it } from 'vitest'
import { lunarLabel, shiftMonth } from '../src/core/lunar'

describe('日历农历小字', () => {
  it('节气优先于农历日', () => {
    expect(lunarLabel(2026, 12, 7)).toEqual({ text: '大雪', kind: 'festival' })
    expect(lunarLabel(2026, 12, 22)).toEqual({ text: '冬至', kind: 'festival' })
  })
  it('公历与农历节日', () => {
    expect(lunarLabel(2026, 12, 25)).toEqual({ text: '圣诞节', kind: 'festival' })
    expect(lunarLabel(2027, 1, 1)).toEqual({ text: '元旦', kind: 'festival' })
    expect(lunarLabel(2026, 12, 4)).toEqual({ text: '宪法日', kind: 'festival' })
    expect(lunarLabel(2027, 2, 6)).toEqual({ text: '春节', kind: 'festival' })
  })
  it('普通日期显示农历', () => {
    expect(lunarLabel(2026, 11, 19)).toEqual({ text: '十一', kind: 'lunar' })
    expect(lunarLabel(2026, 12, 1)).toEqual({ text: '廿三', kind: 'lunar' })
  })
  it('跨年月份偏移与越界兜底（修复 wrong month 13）', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ y: 2027, m: 0 })   // 12 月的下月 = 次年 1 月
    expect(shiftMonth(2027, 0, -1)).toEqual({ y: 2026, m: 11 })
    expect(lunarLabel(2027, 1, 1).text).toBeTruthy()
    expect(lunarLabel(2026, 13, 1)).toEqual({ text: '', kind: 'lunar' })
    expect(lunarLabel(2026, 12, 32)).toEqual({ text: '', kind: 'lunar' })
  })
})
