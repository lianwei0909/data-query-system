// 两行表头班表的导入 / 查人：数据结构取自真实文件
//   1111.xlsx、12月班表.xlsx：首行日期是 Excel 日期型 → 列名 YYYY-MM-DD，姓名列名是「排班原则…」「…_1」「…_2」
//   排班_2026-10-21_11-20.xlsx（智能排班导出）：首行日期是文本「10月21日」，姓名列名是 '' 和 '_1'（空字符串列名）
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeScheduleExport } from '../src/core/readFile'
import { findUserRow, listPeople, resolveNameCols } from '../src/core/shift'
import { computeDayAttendance } from '../src/core/stats'
import { importShiftRows, loadShiftRows, mergeShiftRows, shiftRowKey, shiftRowLabel } from '../src/core/shiftStore'
import { carryFromImported, peopleFromImported } from '../src/solver/schedulerStore'
import type { Person } from '../src/solver/types'

const T1 = '排班原则：最低保障每天早班2人晚班2人'
const T2 = '排班原则：最低保障每天白班2人夜班2人'
const ref = new Date(2026, 10, 18)

// 1111.xlsx 经 readTableFileAsSheet 后的形态（日期列已换成 YYYY-MM-DD）
const SHEET_1111 = [
  { [T1]: '企业名', [T1 + '_1']: '英文名', [T1 + '_2']: '中文名', '2026-11-21': '星期六', '2026-12-01': '星期二', __EMPTY: '' },
  { [T1]: 'kafewu(吴超)', [T1 + '_1']: 'kafewu', [T1 + '_2']: '吴超', '2026-11-21': '休', '2026-12-01': '早班2', __EMPTY: '' },
  { [T1]: 'cuijunfang(崔俊芳)', [T1 + '_1']: 'cuijunfang', [T1 + '_2']: '崔俊芳', '2026-11-21': '休', '2026-12-01': '正常班', __EMPTY: '' },
  { [T1]: '备注', [T1 + '_1']: '备注', [T1 + '_2']: '备注', '2026-11-21': 'hanleywang、ventili…', '2026-12-01': 'hanleywang、ventili…', __EMPTY: '' },
  { [T1]: '', [T1 + '_1']: '', [T1 + '_2']: '早班2', '2026-11-21': '0', '2026-12-01': '1', __EMPTY: '' },
  { [T1]: '小夜班3', [T1 + '_1']: '15 - 24', [T1 + '_2']: '', '2026-11-21': '', '2026-12-01': '', __EMPTY: '' }
]
// 排班_2026-10-21_11-20.xlsx 经 readTableFileAsSheet 后的形态：英文名列的列名是空字符串
const SHEET_EXPORT = [
  { [T2]: '企业名', '': '英文名', _1: '中文名', '10月21日': '星期三', '11月20日': '星期五' },
  { [T2]: 'kafewu(吴超)', '': 'kafewu', _1: '吴超', '10月21日': '休', '11月20日': '白班' },
  { [T2]: 'nomadshi (石浩东)', '': 'nomadshi', _1: '石浩东', '10月21日': '小夜班3', '11月20日': '小夜班3' },
  { [T2]: '', '': '', _1: '白班', '10月21日': '2', '11月20日': '2' }
]

describe('normalizeScheduleExport：两行表头', () => {
  it('Excel 日期型表头（1111.xlsx）：还原 2 个人员行，备注 / 统计 / 图例行全部过滤', () => {
    const out = normalizeScheduleExport(SHEET_1111, ref)!
    expect(out.map(r => r.英文名)).toEqual(['kafewu', 'cuijunfang'])
    expect(out[1]).toMatchObject({ 企业名: 'cuijunfang(崔俊芳)', 中文名: '崔俊芳', '2026-12-01': '正常班' })
  })
  it('英文名列的列名是空字符串（智能排班导出表）：也能识别，原来因 !kEn 判空直接放弃', () => {
    const out = normalizeScheduleExport(SHEET_EXPORT, ref)
    expect(out).not.toBeNull()
    expect(out!.map(r => [r.英文名, r.中文名])).toEqual([['kafewu', '吴超'], ['nomadshi', '石浩东']])
    expect(out![0]).toMatchObject({ '2026-10-21': '休', '2026-11-20': '白班' })
  })
  it('表头上方多一行标题：表头行不在第一行也能找到', () => {
    const withTitle = [{ [T1]: '2026年12月班表', [T1 + '_1']: '', [T1 + '_2']: '', '2026-11-21': '', '2026-12-01': '' }, ...SHEET_1111]
    expect(normalizeScheduleExport(withTitle, ref)!.map(r => r.英文名)).toEqual(['kafewu', 'cuijunfang'])
  })
})

describe('姓名列逐行识别（不再只看第一行）', () => {
  // 旧版本导入两行表头文件留下的行（列名是 `排班原则…_1`），与新导入的标准行混在同一份存储里
  const legacy = { [T1]: 'kafewu(吴超)', [T1 + '_1']: 'kafewu', [T1 + '_2']: '吴超', '2026-11-21': '休', '2026-11-22': '休' }
  const legacyCui = { [T1]: 'cuijunfang(崔俊芳)', [T1 + '_1']: 'cuijunfang', [T1 + '_2']: '崔俊芳', '2026-11-21': '休' }
  const std = { 企业名: 'nomadshi (石浩东)', 英文名: 'nomadshi', 中文名: '石浩东', '2026-12-01': '小夜班3', '2026-12-02': '正常班' }

  it('resolveNameCols：标准列名 / 旧格式列名 / 空字符串列名', () => {
    expect(resolveNameCols(std)).toEqual({ eng: '英文名', cn: '中文名' })
    expect(resolveNameCols(legacy)).toEqual({ eng: T1 + '_1', cn: T1 + '_2' })
    expect(resolveNameCols({ [T2]: 'x(甲)', '': 'alice', _1: '甲', '10月21日': '休' })).toEqual({ eng: '', cn: '_1' })
  })
  it('第一行是旧格式时，后面的标准行照样能查到人（原来按第一行定列，标准行全部查不到）', () => {
    const data = [legacy, std]
    expect(listPeople(data).map(p => p.en)).toEqual(['kafewu', 'nomadshi'])
    expect(findUserRow(data, 'nomadshi')).toBe(std)
    expect(findUserRow(data, '石浩东')).toBe(std)
    const att = computeDayAttendance(data, 'nomadshi', 2026, 12, 1)
    expect(att.night.map(p => [p.name, p.me])).toEqual([['石浩东', true]])
  })
  it('第一行是标准格式时，后面的旧格式行也能查到', () => {
    expect(findUserRow([std, legacy], 'kafewu')).toBe(legacy)
    expect(listPeople([std, legacy]).map(p => p.en)).toEqual(['nomadshi', 'kafewu'])
  })
  it('合并：旧格式行与新导入的同一个人合成一行，改用标准姓名列，旧日期保留', () => {
    const fresh = { 企业名: 'kafewu(吴超)', 英文名: 'kafewu', 中文名: '吴超', '2026-11-22': '早班2', '2026-11-23': '早班2' }
    expect(shiftRowKey(legacy)).toBe('kafewu')
    expect(shiftRowLabel(legacy)).toBe('吴超（kafewu）')
    const merged = mergeShiftRows([legacy, legacyCui], [fresh])
    expect(merged).toHaveLength(2)                                       // 原来：旧行取不到标识被丢弃，崔俊芳整行消失
    const k = merged.find(r => r.英文名 === 'kafewu')!
    expect(k).toEqual({ 企业名: 'kafewu(吴超)', 英文名: 'kafewu', 中文名: '吴超', '2026-11-21': '休', '2026-11-22': '早班2', '2026-11-23': '早班2' })
    expect(findUserRow(merged, 'cuijunfang')).toBe(merged[1])
  })
})

describe('导入 → 日历 → 排班 全流程（旧格式存档 + 导入 1111.xlsx）', () => {
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) }
    }
  })
  it('旧存档里的人不丢；新文件的人与旧行合并；日历和排班都能找到所有人', () => {
    const legacy = [
      { [T1]: 'kafewu(吴超)', [T1 + '_1']: 'kafewu', [T1 + '_2']: '吴超', '2026-11-13': '早班2', '2026-11-20': '小夜班3' },
      { [T1]: 'zaklin(林国宇)', [T1 + '_1']: 'zaklin', [T1 + '_2']: '林国宇', '2026-11-13': '小夜班3', '2026-11-20': '休' }
    ]
    mem.set('importedShiftData', JSON.stringify(legacy))
    importShiftRows(normalizeScheduleExport(SHEET_1111, ref)!)
    const data = loadShiftRows()
    expect(listPeople(data).map(p => p.en).sort()).toEqual(['cuijunfang', 'kafewu', 'zaklin'])
    expect(findUserRow(data, 'kafewu')).toMatchObject({ 英文名: 'kafewu', '2026-11-20': '小夜班3', '2026-12-01': '早班2' })
    expect(findUserRow(data, 'zaklin')).toBeTruthy()
    const ps = peopleFromImported(data)
    expect(ps.map(p => p.en).sort()).toEqual(['cuijunfang', 'kafewu', 'zaklin'])
    const P = (en: string): Person => ({ en, cn: en, org: en, active: true, need: '', prefer: '' })
    const dec = Array.from({ length: 30 }, (_, i) => new Date(2026, 10, 21 + i))
    const carry = carryFromImported(data, [P('kafewu'), P('zaklin')], dec)
    expect(carry).toBeTruthy()
    expect(carry!.carry!.map(c => c[c.length - 1])).toEqual([2, 0])      // 11/20：吴超小夜、林国宇休
  })
})
