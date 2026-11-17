// v2.2 往期习惯：从导入班表学习每人休息星期 / 白班名称，排班时沿用固定轮休、周节奏，不排孤立班
import { describe, expect, it } from 'vitest'
import SCH from '../src/solver/engine.js'
import { habitsOf, peopleFromImported } from '../src/solver/schedulerStore'
import type { Person } from '../src/solver/types'

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
// 手排 12 月的固定轮休（0=周日）：吴超、李安维 周六日；石浩东 周一二；王汉明 周二三；厉津睿、林国宇 周四五
const PAIRS = [6, 1, 6, 2, 4, 4]
const NB = [0.2, 0.38, 0.48, 0.81, 0.52, 0.62]
const hist = (k: number) => { const h = [0, 0, 0, 0, 0, 0, 0]; h[k] = 5; h[(k + 1) % 7] = 5; return h }
const people: Person[] = PAIRS.map((k, i) => ({ en: 'p' + i, cn: '员工' + i, org: 'p' + i, active: true, need: '', prefer: '', nightBias: NB[i], restHist: hist(k), dayLabel: i % 2 ? '正常班' : '早班2' }))

describe('往期习惯学习', () => {
  it('最近 6 周的「休」按星期计数（假不算），白班名称取最常用写法', () => {
    const row: Record<string, string> = { 英文名: 'kafewu', 中文名: '吴超' }
    for (let d = new Date(2026, 9, 1); d <= new Date(2026, 11, 20); d.setDate(d.getDate() + 1)) {
      const w = d.getDay()
      row[ymd(d)] = w === 0 || w === 6 ? '休' : w === 3 ? '年假' : w === 5 ? '小夜班3' : '早班2'
    }
    const h = habitsOf(row, Object.keys(row))
    expect(h.restHist).toEqual([6, 0, 0, 0, 0, 0, 6])       // 11/9 ~ 12/20 共 6 周
    expect(h.dayLabel).toBe('早班2')
    expect(peopleFromImported([row])[0]).toMatchObject({ restHist: [6, 0, 0, 0, 0, 0, 6], dayLabel: '早班2' })
  })
  it('buildInput：往期先验（往期组合罚 0，其余按比例），关掉固定轮休则不设；白班名称按人', () => {
    const dates = SCH.periodDates(2027, 1)
    const input = SCH.buildInput(dates, people, { ...SCH.DEFAULT_RULES }, null, {})
    expect(input.restPrior[0]![6]).toBe(0)
    expect(input.restPrior[0]![0]).toBeGreaterThan(0)
    expect(input.dayLabel.slice(0, 2)).toEqual(['早班2', '正常班'])
    expect(input.dow[0]).toBe(dates[0].getDay())
    const off = SCH.buildInput(dates, people, { ...SCH.DEFAULT_RULES, fixedRest: false }, null, {})
    expect(off.restPrior.every(x => x === null)).toBe(true)
  })
})

describe('按往期习惯排班（启发式，固定种子）', () => {
  const dates = SCH.periodDates(2027, 1), T = dates.length
  const input = SCH.buildInput(dates, people, { ...SCH.DEFAULT_RULES }, null, { heuristic: true })
  /** 每人休息日落在其往期固定两天上的比例 */
  const shareOf = (a: number[][]) => a.map((row, p) => {
    const rest = row.map((v, t) => (v === 0 ? dates[t].getDay() : -1)).filter(w => w >= 0)
    return rest.filter(w => w === PAIRS[p] || w === (PAIRS[p] + 1) % 7).length / rest.length
  })
  const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length
  // 固定种子 → 结果完全确定，阈值只作回归护栏。本地实测（Node 20）：
  //   seed 1：平均 0.795 / 最低 0.70；seed 2：0.782 / 0.50；seed 3：0.783 / 0.60
  //   不固定种子时 16 次实测平均 0.71~0.87、最低 0.44~0.80（CI 随机跑出过 0.66 / 0.40），所以不能用随机种子断言
  const SEEDS = [1, 2, 3]
  const cache = new Map<number, number[][]>()
  const run = (seed: number): number[][] => {
    if (!cache.has(seed)) {
      const res = SCH.solve(input, { seed })
      expect(res.ok).toBe(true)
      cache.set(seed, res.a!)
    }
    return cache.get(seed)!
  }

  it('同一输入 + 同一种子，两次求解结果逐格一致', () => {
    expect(SCH.solve(input, { seed: 1 }).a).toEqual(run(1))
  }, 120_000)

  it.each(SEEDS)('seed %i：人数与小夜约束全部满足，无孤立班，白班沿用往期名称', seed => {
    const a = run(seed)
    for (const row of a) for (let t = 1; t < T - 1; t++) expect(row[t] && !row[t - 1] && !row[t + 1] ? 'iso' : '').toBe('')
    const result = SCH.buildResult(input, a as never)
    expect(SCH.validate(input, result).errors).toEqual([])
    expect(result.grid[0].filter(v => v !== '休' && v !== '小夜班3').every(v => v === '早班2')).toBe(true)
  }, 120_000)

  it('沿用往期固定休息日：3 个种子平均 ≥ 0.75，每次平均 ≥ 0.7，最低的人 ≥ 0.4', () => {
    const avgs = SEEDS.map(s => mean(shareOf(run(s))))
    const mins = SEEDS.map(s => Math.min(...shareOf(run(s))))
    expect(mean(avgs)).toBeGreaterThanOrEqual(0.75)
    for (const v of avgs) expect(v).toBeGreaterThanOrEqual(0.7)
    for (const v of mins) expect(v).toBeGreaterThanOrEqual(0.4)
  }, 120_000)
})
