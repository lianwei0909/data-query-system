// v2.3 自定义需求：「其余人」作用域、按组夜班均分、多夜班 / 少夜班落到夜班目标
import { describe, expect, it } from 'vitest'
import SCH from '../src/solver/engine.js'
import type { Person } from '../src/solver/types'

const dates = SCH.periodDates(2027, 1)
const CN = ['张三', '李四', '王五', '赵六', '钱七', '孙八']
const NB = [0.2, 0.38, 0.48, 0.81, 0.52, 0.62]
const mk = (active = true): Person[] => CN.map((cn, i) => ({ en: 'p' + i, cn, org: 'p' + i, active, need: '', prefer: '', nightBias: NB[i] }))
const TEXT = '孙八，赵六，钱七多夜班，其余人夜班均分'

describe('自定义需求：其余人', () => {
  it('点名的人与「其余人」分成两组，识别结果按组展示', () => {
    const c = SCH.parseCustomNeed(TEXT, dates, mk())
    expect(c.others!.names).toEqual(['张三', '李四', '王五'])
    ;['孙八', '赵六', '钱七'].forEach(n => { expect(c.byName[n].prefer).toBe('night'); expect(c.byName[n].balance).toEqual([]) })
    ;['张三', '李四', '王五'].forEach(n => { expect(c.byName[n].balance).toEqual(['night']); expect(c.byName[n].prefer).toBe('') })
    expect(c.global).toBeNull()
    expect(SCH.describeCustom(c)).toBe('孙八、赵六、钱七：偏夜班；其余人（张三、李四、王五）：夜班平均分配')
  })
  it('各种写法 / 顺序都识别成同一结果', () => {
    for (const t of ['孙八、赵六、钱七多夜班，其他人夜班平均分配', '孙八赵六钱七三人多夜班；剩下的人夜班均分', '其余3人夜班均分，孙八和赵六和钱七都多上点夜班']) {
      const c = SCH.parseCustomNeed(t, dates, mk())
      expect(c.others!.names, t).toEqual(['张三', '李四', '王五'])
      expect(c.byName['钱七'].prefer, t).toBe('night')
      expect(c.invalid, t).toEqual([])
    }
  })
  it('不参与排班的人不算「其余人」；人数写错给提示；其余X人不会被当成「其余星期上夜班」', () => {
    const ps = mk(); ps[2].active = false
    expect(SCH.parseCustomNeed(TEXT, dates, ps).others!.names).toEqual(['张三', '李四'])
    const c = SCH.parseCustomNeed('孙八多夜班，其余3人少夜班', dates, mk())
    expect(c.byName['孙八'].weekNight).toEqual([])
    expect(c.byName['张三'].prefer).toBe('day')
    expect(c.notes.join()).toContain('实际是 5 人')
    expect(SCH.parseCustomNeed('孙八：周四周五白班，其余夜班', dates, mk()).byName['孙八'].weekNight).toEqual([1, 2, 3, 6, 7])
  })
})

describe('夜班目标：多夜班 + 组内均分', () => {
  it('均分只在写了的人之间拉平，多夜班的人目标更高，总量不变', () => {
    const custom = SCH.parseCustomNeed(TEXT, dates, mk())
    const input = SCH.buildInput(dates, mk(), { ...SCH.DEFAULT_RULES }, null, { custom })
    expect(input.balNight).toEqual([true, true, true, false, false, false])
    const nt = input.nightTarget
    expect(nt[0]).toBeCloseTo(nt[1], 6); expect(nt[1]).toBeCloseTo(nt[2], 6)
    expect(Math.min(nt[3], nt[4], nt[5])).toBeGreaterThan(nt[0] + 4)
    const all = SCH.buildInput(dates, mk(), { ...SCH.DEFAULT_RULES }, null, {})
    expect(nt.reduce((a, b) => a + b, 0)).toBeCloseTo(all.nightTarget.reduce((a, b) => a + b, 0), 3)
    expect(input.nightPlan).toContain('夜班均分 张三、李四、王五')
  })
  it('「夜班平均一下」（全员）保持原口径：每人等额', () => {
    const custom = SCH.parseCustomNeed('夜班平均一下', dates, mk())
    const input = SCH.buildInput(dates, mk(), { ...SCH.DEFAULT_RULES }, null, { custom })
    expect(input.balNight!.every(Boolean)).toBe(true)
    expect(new Set(input.nightTarget.map(x => x.toFixed(6))).size).toBe(1)
  })
  it('启发式排班：多夜班的人夜班都多于均分组，均分组在允许范围内', () => {
    const custom = SCH.parseCustomNeed(TEXT, dates, mk())
    const input = SCH.buildInput(dates, mk(), { ...SCH.DEFAULT_RULES }, null, { heuristic: true, custom })
    const res = SCH.solve(input, { seed: 7 })
    const n = res.a!.map(r => r.filter(v => v === 2).length)
    const avg = input.nightTarget[0], lo = Math.max(0, Math.floor(avg) - 1), hi = Math.ceil(avg) + 1
    n.slice(0, 3).forEach(x => { expect(x).toBeGreaterThanOrEqual(lo); expect(x).toBeLessThanOrEqual(hi) })
    expect(Math.min(...n.slice(3))).toBeGreaterThan(Math.max(...n.slice(0, 3)))
    const v = SCH.validate(input, SCH.buildResult(input, res.a!))
    expect(v.errors.filter(e => /未平均/.test(e))).toEqual([])
    expect(v.notes.join()).toContain('实际夜班')
  }, 90000)
})
