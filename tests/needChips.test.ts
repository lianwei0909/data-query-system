import { describe, expect, it } from 'vitest'
import { needChips } from '../src/solver/schedulerStore'
import type { NeedParse } from '../src/solver/types'

const base = (): NeedParse => ({
  leave: [], off: [], fix: [], work: [], weekDay: [], weekNight: [], weekOff: [], weekWork: [],
  prefer: '', target: null, counts: [], balance: [], nightAll: false, dayAll: false, invalid: [], notes: []
})

describe('needChips（需求识别结果 → 彩色标签）', () => {
  it('按类型输出标签，日期格式化为 M/D', () => {
    const n = base()
    n.leave = ['2026-11-25:年假']
    n.off = ['2026-11-26']
    n.fix = ['2026-11-27:白班', '2026-11-28:小夜班3']
    n.weekNight = [4, 5]
    n.prefer = 'day'
    n.invalid = ['随便写写']
    const chips = needChips(n)
    expect(chips.map(c => c.kind)).toEqual(['leave', 'off', 'day', 'night', 'night', 'prefer', 'bad'])
    expect(chips[0].text).toBe('11/25 年假')
    expect(chips[1].text).toBe('11/26')
    expect(chips.some(c => c.kind === 'bad' && c.text.includes('随便写写'))).toBe(true)
  })

  it('空需求、null 输入、计数与均分标签', () => {
    expect(needChips(base())).toEqual([])
    expect(needChips(null)).toEqual([])
    const n = base()
    n.target = 21
    n.counts = [{ kind: 'night', op: 'max', n: 10 }]
    n.balance = ['night']
    n.dayAll = true
    const chips = needChips(n)
    expect(chips.map(c => c.text)).toEqual(['上班 21 天', '夜班≤10', '夜班均分', '全白班'])
  })
})
