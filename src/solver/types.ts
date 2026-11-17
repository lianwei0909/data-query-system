// 排班领域类型：engine.js（算法）、schedulerStore.ts（页面状态）、Vue 组件、Worker 共用
/** 班次编码：0 = 休/假，1 = 白班，2 = 夜班 */
export type ShiftCode = 0 | 1 | 2
export const OFF = 0, DAY = 1, NIGHT = 2
/** 固定编码：0 自由 1 必休 2 指定白班 3 指定夜班 4 请假 5 上班则白班 6 上班则夜班 7 必须上班 */
export type FixCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface Person {
  en: string
  cn: string
  org: string
  active: boolean
  /** 一句话需求（请假 / 休息 / 指定班次 / 星期规律 / 偏好） */
  need: string
  prefer: string
  /** 往期夜班占出勤比例，仅作软目标 */
  nightBias?: number
  /** 往期习惯（从导入班表重算）：最近 6 周「休」落在周日~周六的次数；最常用的白班写法（早班2 / 正常班 / 白班） */
  restHist?: number[]
  dayLabel?: string
  target?: number
  /** v1 老存档的结构化字段，加载时迁移成 need */
  weekDay?: string
  weekNight?: string
}

export interface Rules {
  minDay: number
  minNight: number
  maxStaff: number
  maxRun: number
  targetDays: number
  nightToDayHard: boolean
  /** 每人每周固定休息相邻两天（参考往期），默认开 */
  fixedRest?: boolean
  v: number
}
export type RuleNumKey = 'minDay' | 'minNight' | 'maxStaff' | 'maxRun' | 'targetDays'

export type CountKind = 'work' | 'day' | 'night' | 'total'
export type CountOp = 'eq' | 'min' | 'max'
export type BalanceKind = 'night' | 'day' | 'weekend' | 'work'
export interface CountReq { kind: CountKind; op: CountOp; n: number; soft?: boolean }

/** parseNeedText 的结果：日期类条目为 'YYYY-M-D' / 'YYYY-M-D:年假' / 'YYYY-M-D:白班'，星期为 1-7（7 = 周日） */
export interface NeedParse {
  leave: string[]
  off: string[]
  fix: string[]
  work: string[]
  weekDay: number[]
  weekNight: number[]
  weekOff: number[]
  weekWork: number[]
  prefer: '' | 'day' | 'night'
  target: number | null
  counts: CountReq[]
  balance: BalanceKind[]
  nightAll: boolean
  dayAll: boolean
  invalid: string[]
  notes: string[]
}

export interface DayRule { kind: CountKind; op: CountOp; n: number; days: number[]; scope: string; labels: string[] }
export interface CustomNeed {
  global: NeedParse | null
  byName: Record<string, NeedParse>
  dayRules: DayRule[]
  invalid: string[]
  notes: string[]
}

export interface SchedulerInput {
  dates: Date[]
  people: Person[]
  rules: Rules
  /** 每天是星期几（0=周日） */
  dow: number[]
  /** 固定轮休的往期先验：7 种「相邻两天」组合各自的罚分；无往期为 null */
  restPrior: (number[] | null)[]
  /** 每人的白班名称 */
  dayLabel: string[]
  nightTarget: number[]
  fixed: FixCode[][]
  leaveName: string[][]
  targets: number[]
  prefers: string[]
  weekend: boolean[]
  carry: ShiftCode[][] | null
  conflicts: string[]
  countReqs: (CountReq & { p: number; soft: boolean })[]
  balance: BalanceKind[]
  dayRules: DayRule[]
  customNotes: string[]
  needNotes: string[]
}
export interface BuildOpts { heuristic?: boolean; needNotes?: string[]; custom?: CustomNeed | null }

export interface SolveResult {
  ok: boolean
  a?: ShiftCode[][]
  reason?: string
  engine?: 'highs' | 'precheck'
  status?: string
  ms?: number
  hardIssues?: string[]
  soloIssues?: string[]
  cost?: { hard: number; soft: number }
}
export interface SolveExactOpts { seed?: number; stage1Limit?: number; stage2Limit?: number }
export interface SolverSession {
  run(lp: string, options: Record<string, unknown>): Promise<any>
  close(): void
}

export interface PersonStat {
  cn: string; en: string; org: string
  work: number; rest: number; leave: number; leaveDetail: Record<string, number>
  day: number; night: number; weekend: number; maxRun: number
}
export interface DayStat { day: number; night: number; total: number; rest: number }
export interface ScheduleResult {
  /** 每人每天的班次名：白班 / 小夜班3 / 休 / 假别 */
  grid: string[][]
  personStats: PersonStat[]
  dayStats: DayStat[]
  dayDuty: string[]
  nightDuty: string[]
  raw: ShiftCode[][]
}
export interface Validation { errors: string[]; notes: string[]; solo: string[] }

/** 跨周期衔接：source=import 取自导入的实际班表，source=last 取自本工具上次生成的排班 */
export interface CarryInfo {
  carry: ShiftCode[][] | null
  linked: boolean
  gap: number
  source?: 'import' | 'last'
  days?: number
  missing?: string[]
}
