import { describe, expect, it } from 'vitest'
import SCH from '../src/solver/engine.js'
import type { Person } from '../src/solver/types'

const dates = SCH.periodDates(2026, 12)
const person = (i: number, need = ''): Person => ({ en: 'p' + i, cn: '员工' + i, org: 'p' + i, active: true, need, prefer: '', nightBias: 0.5 })

describe('需求解析', () => {
  it('一句话需求 → 结构化约束 → 识别结果文案', () => {
    const n = SCH.parseNeedText('11月25日-27日年假，12月8、9号休，周四周五休，周末白班，其余夜班，尽量少上夜班', dates)
    expect(n.leave).toEqual(['2026-11-25:年假', '2026-11-26:年假', '2026-11-27:年假'])
    expect([n.weekOff, n.weekDay, n.weekNight, n.prefer]).toEqual([[4, 5], [6, 7], [1, 2, 3], 'day'])
    expect(SCH.describeNeed(n)).toBe('假 11/25年假、11/26年假、11/27年假 · 休 12/8、12/9 · 每周四五休 · 周六日白班 · 周一二三夜班 · 偏白班')
  })
  it('同一天既休息又指定班次 → 当场提示冲突', () => {
    expect(SCH.parseNeedText('12月8号休，12月8号白班', dates).invalid.join()).toContain('同时填了休息和白班')
  })
  it('自定义需求：每日人数规则 + 点名 + 全员', () => {
    const c = SCH.parseCustomNeed('12月31日不休；每天白班至少3人；员工1：12月1日-2日年假', dates, [person(1)])
    expect(c.dayRules[0]).toMatchObject({ kind: 'day', op: 'min', n: 3, scope: 'all' })
    expect(c.byName['员工1'].leave.length).toBe(2)
    expect(c.invalid.length).toBeGreaterThan(0)          // 12月31日不在 11/21~12/20 周期内
  })
})

describe('建模 / 求解 / 校验', () => {
  const people = Array.from({ length: 7 }, (_, i) => person(i + 1, i === 0 ? '11月25日-26日年假' : ''))
  it('buildInput：请假落到固定编码 4，目标天数取规则', () => {
    const input = SCH.buildInput(dates, people, { ...SCH.DEFAULT_RULES }, null, {})
    expect(input.fixed[0][4]).toBe(4)
    expect(input.leaveName[0][4]).toBe('年假')
    expect(input.targets).toEqual(Array(7).fill(21))
  })
  it('全员同一天请假 → 预检直接拦下并说明原因', () => {
    const all = people.map(p => ({ ...p, need: '11月30日年假' }))
    const chk = SCH.precheck(SCH.buildInput(dates, all, { ...SCH.DEFAULT_RULES }, null, {}))
    expect(chk.ok).toBe(false)
    expect(chk.reason).toBeTruthy()
  })
  it('启发式求解 + 独立校验：7 人 30 天给出完整班表', () => {
    const input = SCH.buildInput(dates, people, { ...SCH.DEFAULT_RULES }, null, { heuristic: true })
    const res = SCH.solve(input)
    expect(res.a).toBeTruthy()
    const result = SCH.buildResult(input, res.a!)
    expect(result.grid.length).toBe(7)
    expect(result.grid[0].length).toBe(dates.length)
    expect(result.grid[0][4]).toBe('年假')
    const v = SCH.validate(input, result)
    expect(Array.isArray(v.errors)).toBe(true)
    expect(result.dayStats.every(s => s.total === s.day + s.night)).toBe(true)
  }, 60000)
})
