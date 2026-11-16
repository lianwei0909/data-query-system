import { describe, it, expect } from 'vitest'
import { mergeShiftRows, normalizeShiftRows, shiftDateRange } from '../src/core/shiftStore'

describe('班表合并与迁移', () => {
  it('同人按日期合并、新人追加、旧周期保留（v1 会整体覆盖）', () => {
    const mg = mergeShiftRows(
      [{ 英文名: 'alice', '2026-11-20': '白班', '2026-11-21': '休' }, { 英文名: 'bob', '2026-11-20': '夜班' }],
      [{ 英文名: 'Alice', '2026-11-21': '白班', '2026-11-22': '夜班' }, { 英文名: 'carol', '2026-11-21': '白班' }]
    )
    const a = mg.find(r => String(r.英文名).toLowerCase() === 'alice')!
    expect(mg.length).toBe(3)
    expect([a['2026-11-20'], a['2026-11-21'], a['2026-11-22']]).toEqual(['白班', '白班', '夜班'])
  })
  it('新数据为空的格子不覆盖旧值', () => {
    const mg = mergeShiftRows([{ 英文名: 'x', '2026-11-20': '白班' }], [{ 英文名: 'x', '2026-11-20': '' }])
    expect(mg[0]['2026-11-20']).toBe('白班')
  })
  it('旧版「X月X日」迁移为带年份', () => {
    const r = normalizeShiftRows([{ 英文名: 'x', '11月16日': '白班' }], new Date(2026, 10, 16))
    expect(r.changed).toBe(true)
    expect(r.rows[0]['2026-11-16']).toBe('白班')
  })
  it('日期范围', () => {
    expect(shiftDateRange([{ '2026-11-21': 'a', '2026-10-21': 'b' }])).toEqual({ from: '2026-10-21', to: '2026-11-21', days: 2 })
  })
})
