// 主线程侧：创建 Worker、转发进度、支持取消；Worker 不可用时回退到主线程求解
import { ref } from 'vue'
import SCH from './scheduler-core.js'

export interface SolverJob {
  dates: Date[]
  people: Record<string, unknown>[]
  rules: Record<string, unknown>
  carry: unknown
  needNotes: string[]
  custom: unknown
}
export interface SolverOutcome { input: any; res: any; note: string }

export type ProgressStage = 'build' | 'stage1' | 'stage2' | 'solve' | 'fallback' | 'cancel'
export const progress = ref<ProgressStage | null>(null)
export const progressText = ref('')

const STAGE_TEXT: Record<string, string> = {
  build: '正在构建排班模型…',
  stage1: '第 1 阶段：满足硬性要求并尽量双休…',
  stage2: '第 2 阶段：优化班型分配…',
  solve: '正在求解…',
  fallback: '精确求解不可用，改用备用算法…'
}

let worker: Worker | null = null
export function cancelSolve(): void {
  if (worker) { worker.terminate(); worker = null }
  progress.value = 'cancel'
  progressText.value = '已取消'
}

export function solveInWorker(job: SolverJob): Promise<SolverOutcome> {
  progress.value = 'build'; progressText.value = STAGE_TEXT.build
  if (typeof Worker === 'undefined') return solveLocally(job)
  return new Promise<SolverOutcome>((resolve, reject) => {
    try {
      // 经典 Worker（vite worker.format = 'iife'）：Worker 内要用 importScripts 加载 emscripten 版 highs.js，模块 Worker 不支持
      worker = new Worker(new URL('./solver.worker.ts', import.meta.url))
    } catch (e) { return solveLocally(job).then(resolve, reject) }
    const w = worker
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data || {}
      if (m.type === 'progress') {
        progress.value = m.stage; progressText.value = STAGE_TEXT[m.stage] || ''
      } else if (m.type === 'done') {
        progress.value = null; progressText.value = ''
        w.terminate(); if (worker === w) worker = null
        resolve({ input: m.input, res: m.res, note: m.note || '' })
      } else if (m.type === 'error') {
        progress.value = null; w.terminate(); if (worker === w) worker = null
        reject(new Error(m.message || '求解失败'))
      }
    }
    w.onerror = (e) => {
      progress.value = null; w.terminate(); if (worker === w) worker = null
      solveLocally(job).then(resolve, reject)
      void e
    }
    // 诊断开关：URL 带 ?solverLimit=秒 时缩短 HiGHS 时间上限（低内存环境 / 自动化测试用），默认不生效
    const lim = Number(new URLSearchParams(location.search).get('solverLimit')) || undefined
    w.postMessage({
      stage1Limit: lim, stage2Limit: lim ? Math.min(lim, 3) : undefined,
      dates: job.dates.map(d => d.toISOString()),
      people: job.people, rules: job.rules, carry: job.carry,
      needNotes: job.needNotes, custom: job.custom
    })
  })
}

/** 不支持 Worker 的环境（老浏览器）：退回主线程求解 */
async function solveLocally(job: SolverJob): Promise<SolverOutcome> {
  progress.value = 'solve'; progressText.value = STAGE_TEXT.solve
  const base = { needNotes: job.needNotes, custom: job.custom }
  const input = SCH.buildInput(job.dates, job.people, job.rules, job.carry, base)
  try {
    const res = await SCH.solveExact(input)
    const note = res.engine === 'highs' ? '精确求解用时 ' + (res.ms / 1000).toFixed(1) + ' 秒' : ''
    progress.value = null
    return { input, res, note }
  } catch (e) {
    const hin = SCH.buildInput(job.dates, job.people, job.rules, job.carry, { ...base, heuristic: true })
    progress.value = null
    return { input: hin, res: SCH.solve(hin), note: '⚠ 精确求解不可用，已改用备用算法' }
  }
}
