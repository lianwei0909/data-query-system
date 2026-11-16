import { describe, it, expect } from 'vitest'
import { inferDateKeys, parseDateKey, periodOf, localDateStr, ymdKey } from '../src/core/date'

describe('日期列推断年份', () => {
  it('跨年周期：12月21日 ~ 1月20日', () => {
    const m = inferDateKeys(['企业名', '12月21日', '12月31日', '1月1日', '1月20日'], new Date(2026, 11, 10))
    expect(m['12月21日']).toBe('2026-12-21')
    expect(m['1月1日']).toBe('2027-01-01')
    expect(m['1月20日']).toBe('2027-01-20')
    expect(m['企业名']).toBeUndefined()
  })
  it('普通周期', () => {
    const m = inferDateKeys(['10月21日', '11月20日'], new Date(2026, 10, 16))
    expect(m['10月21日']).toBe('2026-10-21')
    expect(m['11月20日']).toBe('2026-11-20')
  })
  it('自带年份的列原样保留', () => {
    const m = inferDateKeys(['2025-12-30', '2025年12月31日', '2025/1/2'], new Date(2026, 10, 16))
    expect(m['2025-12-30']).toBe('2025-12-30')
    expect(m['2025年12月31日']).toBe('2025-12-31')
    expect(m['2025/1/2']).toBe('2025-01-02')
  })
  it('非法日期不识别', () => {
    expect(parseDateKey('13月1日')).not.toBeNull()   // 解析成功但 inferDateKeys 会过滤
    expect(inferDateKeys(['13月1日', '备注'])).toEqual({})
  })
})

describe('排班周期与本地日期', () => {
  it('20 号属于本月周期，21 号进入下一周期', () => {
    const p20 = periodOf(new Date(2026, 10, 20)), p21 = periodOf(new Date(2026, 10, 21))
    expect(ymdKey(p20.start.getFullYear(), p20.start.getMonth() + 1, p20.start.getDate())).toBe('2026-10-21')
    expect(ymdKey(p21.start.getFullYear(), p21.start.getMonth() + 1, p21.start.getDate())).toBe('2026-11-21')
    expect(p21.end.getMonth()).toBe(11)
  })
  it('跨年周期结束于次年 1 月 20 日', () => {
    const p = periodOf(new Date(2026, 11, 25))
    expect(p.end.getFullYear()).toBe(2027)
    expect(p.end.getDate()).toBe(20)
  })
  it('localDateStr 用本地时区（凌晨 3 点不会变成前一天）', () => {
    expect(localDateStr(new Date(2026, 0, 2, 3))).toBe('2026-01-02')
  })
})
