import type {
  BuildOpts, CustomNeed, NeedParse, Person, Rules, ScheduleResult, SchedulerInput, ShiftCode,
  SolveExactOpts, SolveResult, SolverSession, Validation
} from './types'

declare const SCH: {
  readonly LEAVE_TYPES: string[]
  readonly DEFAULT_PEOPLE: Person[]
  readonly DEFAULT_RULES: Rules
  readonly MIP: { HARD_W: number; SOLO_W: number; stage1Limit: number; stage2Limit: number }
  /** 周期 = 上月 21 日 ~ 本月 20 日，month 为结束月 1-12 */
  periodDates(year: number, month: number): Date[]
  isWeekend(d: Date): boolean
  weekdayCn(d: Date): string
  /** 'YYYY-M-D'（不补零） */
  keyOf(d: Date): string
  parseNeedText(text: string, dates?: Date[] | null): NeedParse
  describeNeed(n: NeedParse): string
  /** people 里 active === false 的人不计入「其余人」 */
  parseCustomNeed(text: string, dates: Date[] | null, people: (Pick<Person, 'cn' | 'en'> & { active?: boolean })[]): CustomNeed
  describeCustom(c: CustomNeed | null): string
  buildInput(dates: Date[], people: Person[], rules: Rules, carry: ShiftCode[][] | null, opts?: BuildOpts): SchedulerInput
  precheck(input: SchedulerInput): { ok: boolean; reason?: string }
  /** 精确求解（HiGHS 两阶段 MIP）；需先 setSolverFactory 注入求解器 */
  solveExact(input: SchedulerInput, opts?: SolveExactOpts): Promise<SolveResult>
  /** 启发式兜底（构造 + 定向修复 + 模拟退火），同步执行 */
  /** 启发式求解；opts.seed 固定伪随机种子（同输入同种子结果一致），不传则每次随机 */
  solve(input: SchedulerInput, opts?: { seed?: number }): SolveResult
  loadHighs(): Promise<unknown>
  openSolver(): Promise<SolverSession>
  buildResult(input: SchedulerInput, a: ShiftCode[][]): ScheduleResult
  /** 独立校验，不信任求解器自检 */
  validate(input: SchedulerInput, result: ScheduleResult): Validation
  /** 需先 setXlsx 注入 xlsx-js-style；未注入返回 false */
  exportXlsx(input: SchedulerInput, result: ScheduleResult, fileName: string): boolean
  setSolverFactory(f: (() => SolverSession) | null): void
  setProgressHook(f: ((stage: string, limit: number) => void) | null): void
  setXlsx(x: unknown): void
}
export default SCH
