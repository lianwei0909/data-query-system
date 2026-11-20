import { beforeEach, describe, expect, it } from 'vitest'
import { clearShiftRows, diffShiftRows, importShiftRows, loadShiftRows, mergeShiftRows, replaceShiftRows, shiftRowLabel, shiftState } from '../src/core/shiftStore'

const OLD = [
  { 英文名: 'alice', 中文名: '张一', '2026-11-20': '白班', '2026-11-21': '休', '2026-11-22': '' },
  { 英文名: 'bob', 中文名: '李二', '2026-11-20': '小夜班3' },
  { 中文名: '', 英文名: '', '2026-11-20': '值班说明' }
]
const NEW = [
  { 英文名: 'Alice', 中文名: '张一', '2026-11-21': '白班', '2026-11-22': '小夜班3', '2026-11-23': '休', '2026-11-20': '白班' },
  { 英文名: 'bob', 中文名: '李二', '2026-11-20': '', '2026-11-21': '年假' },
  { 英文名: 'carol', 中文名: '王三', '2026-11-21': '白班' },
  { 英文名: 'carol', 中文名: '王三', '2026-11-22': '休' },
  { 英文名: '', 中文名: '', '2026-11-21': '备注' }
]

describe('导入差异预览', () => {
  it('新增人员 / 填空 / 覆盖 / 相同 / 无法识别的行', () => {
    const d = diffShiftRows(OLD, NEW)
    expect(d.newPeople).toEqual(['王三（carol）'])
    expect(d.changed).toEqual([{ person: '张一（alice）', date: '2026-11-21', from: '休', to: '白班' }])
    expect(d.added).toBe(3)            // alice 11-22、11-23，bob 11-21
    expect(d.unchanged).toBe(1)        // alice 11-20
    expect(d.unnamed).toBe(1)
    expect(d.range).toEqual({ from: '2026-11-20', to: '2026-11-23', days: 4 })
    expect(d.newDates).toBe(2)         // 11-22（旧表整列为空）、11-23
  })
  it('预览与实际合并结果一致：覆盖的格子合并后取新值，空格不清空旧值', () => {
    const d = diffShiftRows(OLD, NEW)
    const merged = mergeShiftRows(OLD, NEW)
    const alice = merged.find(r => String(r.英文名).toLowerCase() === 'alice')!
    const bob = merged.find(r => r.英文名 === 'bob')!
    d.changed.forEach(c => expect(alice[c.date]).toBe(c.to))
    expect(bob['2026-11-20']).toBe('小夜班3')
  })
  it('首次导入：全部是新人员，没有覆盖', () => {
    const d = diffShiftRows([], NEW)
    expect(d.newPeople).toEqual(['张一（Alice）', '李二（bob）', '王三（carol）'])
    expect([d.added, d.changed.length, d.unchanged]).toEqual([0, 0, 0])
    expect(d.newDates).toBe(4)
  })
  it('人员显示名', () => {
    expect(shiftRowLabel({ 英文名: 'x', 中文名: 'x' })).toBe('x')
    expect(shiftRowLabel({ 企业名: 'corp' })).toBe('corp')
  })
})

describe('撤销导入', () => {
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) }
    }
  })
  it('导入前备份 → 导入 → 整体还原', () => {
    mem.set('importedShiftData', JSON.stringify(OLD))
    const backup = loadShiftRows()
    importShiftRows(NEW)
    expect(loadShiftRows().length).toBe(4)
    const v = shiftState.version
    replaceShiftRows(backup)
    expect(JSON.parse(mem.get('importedShiftData')!)).toEqual(backup)
    expect(shiftState.version).toBe(v + 1)
  })
  it('清空班表：删除班表/查看人/上次排班存档，并触发刷新', () => {
    mem.set('importedShiftData', JSON.stringify(OLD))
    mem.set('viewer_name', 'alice')
    mem.set('scheduler_last', '{}')
    loadShiftRows()
    const v = shiftState.version
    clearShiftRows()
    expect(mem.has('importedShiftData')).toBe(false)
    expect(mem.has('viewer_name')).toBe(false)
    expect(mem.has('scheduler_last')).toBe(false)
    expect(loadShiftRows()).toEqual([])
    expect(shiftState.version).toBeGreaterThan(v)
  })
})
