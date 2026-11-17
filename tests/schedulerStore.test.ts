import { describe, expect, it } from 'vitest'
import * as S from '../src/solver/schedulerStore'
import SCH from '../src/solver/engine.js'
import type { StorageLike } from '../src/core/storage'
import type { Person } from '../src/solver/types'

function memLS(init: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(init))
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: k => { map.delete(k) } }
}
const P = (en: string, cn = en): Person => ({ en, cn, org: en, active: true, need: '', prefer: '' })
// 两人的导入班表：覆盖 2026-11-13 ~ 2026-11-20（12 月周期 = 11/21 ~ 12/20 的前 8 天）
const rows = [
  { 英文名: 'alice', 中文名: '甲', 企业名: 'alice', '2026-11-13': '白班', '2026-11-14': '休', '2026-11-15': '小夜班3', '2026-11-16': '小夜班3', '2026-11-17': '休', '2026-11-18': '年假', '2026-11-19': '白班', '2026-11-20': '小夜班3' },
  { 英文名: 'bob', 中文名: '乙', 企业名: 'bob', '2026-11-13': '白班', '2026-11-14': '白班', '2026-11-15': '', '2026-11-16': '白班', '2026-11-17': '小夜班3', '2026-11-18': '休', '2026-11-19': '休', '2026-11-20': '白班' },
  { 英文名: '', 中文名: '值班', 企业名: '', '2026-11-13': '甲', '2026-11-14': '乙' }
]

describe('人员', () => {
  it('从导入班表提取人员并统计夜班占比，跳过说明行', () => {
    const ps = S.peopleFromImported(rows)
    expect(ps.map(p => [p.en, p.cn, p.nightBias])).toEqual([['alice', '甲', 0.6], ['bob', '乙', 0.2]])
  })
  it('老存档迁移：weekDay/weekNight → 需求文字；旧预置需求清空；补上班表新出现的人', () => {
    const ls = memLS({ scheduler_people: JSON.stringify([
      { en: 'alice', cn: '甲', org: 'alice', active: false, weekDay: '4,5', weekNight: '1,2' },
      { en: 'carol', cn: '丙', org: 'carol', active: true, need: '周四周五白班，其余夜班', prefer: 'night' }
    ]) })
    const ps = S.loadPeople(rows, ls)
    expect(ps.map(p => [p.en, p.active, p.need, p.prefer])).toEqual([
      ['alice', false, '周四五白班，周一二夜班', ''], ['carol', true, '', ''], ['bob', true, '', '']
    ])
    expect(ps[0].nightBias).toBe(0.6)
  })
  it('存档损坏时按班表重新提取', () => {
    expect(S.loadPeople(rows, memLS({ scheduler_people: '{bad' })).length).toBe(2)
  })
})

describe('规则', () => {
  it('无存档返回默认；旧版存档升级为小夜硬约束并回写；残缺存档补齐默认值', () => {
    expect(S.loadRules(memLS())).toEqual(SCH.DEFAULT_RULES)
    const ls = memLS({ scheduler_rules: JSON.stringify({ ...SCH.DEFAULT_RULES, minDay: 3, nightToDayHard: false, v: 1 }) })
    const r = S.loadRules(ls)
    expect([r.minDay, r.nightToDayHard, r.v]).toEqual([3, true, 2])
    expect(JSON.parse(ls.map.get('scheduler_rules')!).v).toBe(2)
    expect(S.loadRules(memLS({ scheduler_rules: '{"minDay":4,"v":2}' }))).toEqual({ ...SCH.DEFAULT_RULES, minDay: 4 })
  })
})

describe('跨周期衔接', () => {
  const dates = SCH.periodDates(2026, 12)
  it('优先取导入班表的上期最后 8 天，中间断档只保留紧挨本期的连续段', () => {
    const c = S.loadCarry([P('alice'), P('bob'), P('dave')], dates, rows, memLS())
    expect(c).toEqual({ carry: [[1, 0, 2, 2, 0, 0, 1, 2], [1, 2, 0, 0, 1], []], linked: true, gap: 1, source: 'import', days: 8, missing: ['dave'] })
  })
  it('没有导入班表时用上次排班存档；间隔 3 天补 2 天休息；间隔超过 7 天不衔接', () => {
    const last = (end: string) => memLS({ scheduler_last: JSON.stringify({ dates: ['2026-11-19', end], people: [{ en: 'alice', cn: '甲' }], raw: [[1, 2]] }) })
    expect(S.loadCarry([P('alice')], dates, [], last('2026-11-20'))).toEqual({ carry: [[1, 2]], linked: true, gap: 1, source: 'last' })
    expect(S.loadCarry([P('alice')], dates, [], last('2026-11-18')).carry).toEqual([[1, 2, 0, 0]])
    expect(S.loadCarry([P('alice')], dates, [], last('2026-11-10')).linked).toBe(false)
  })
  it('单元格与列名识别', () => {
    expect(['', '休', '年假', '小夜班3', '晚班', '白班', '早班2'].map(S.shiftCode)).toEqual([null, 0, 0, 2, 2, 1, 1])
    const d = new Date(2026, 10, 20)
    expect(['11月20日', '11月20号', '2026-11-20', '2026/11/20', '11/20', '11/21', '2025-11-20'].map(k => S.dateKeyMatch(k, d))).toEqual([true, true, true, true, true, false, false])
  })
})

describe('周期与文案', () => {
  it('默认排下一个周期（21 号起算）', () => {
    expect(S.defaultPeriod(new Date(2026, 10, 20))).toEqual({ year: 2026, month: 11 })
    expect(S.defaultPeriod(new Date(2026, 10, 21))).toEqual({ year: 2026, month: 12 })
    expect(S.defaultPeriod(new Date(2026, 11, 25))).toEqual({ year: 2027, month: 1 })
  })
  it('周期标签与导出文件名', () => {
    const ds = SCH.periodDates(2027, 1)
    expect(S.periodLabel(ds)).toBe('2026年12月21日 ~ 2027年1月20日（共 31 天）')
    expect(S.exportFileName(ds)).toBe('排班_2026-12-21_01-20.xlsx')
  })
})
