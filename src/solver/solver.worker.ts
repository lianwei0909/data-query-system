/// <reference lib="webworker" />
/* 排班求解 Worker：精确求解（HiGHS）+ 启发式兜底都在这里跑，主线程不卡；进度实时回传，主线程可 terminate 取消 */
import SCH from './engine.js'
import type { SolveResult } from './types'

type HiGHS = { solve: (lp: string, opts: Record<string, unknown>) => any }

let highs: HiGHS | null = null
let highsPromise: Promise<HiGHS> | null = null
function getHighs(): Promise<HiGHS> {
  if (!highsPromise) {
    highsPromise = new Promise<HiGHS>((resolve, reject) => {
      try {
        // highs.js 是 emscripten UMD，位于站点根目录（public/highs.js），worker 产物在 assets/ 下
        ;(self as unknown as { importScripts: (u: string) => void }).importScripts(new URL('../highs.js', self.location.href).href)
        const factory = (self as unknown as { Module: (cfg: unknown) => Promise<HiGHS> }).Module
        factory({ locateFile: (f: string) => new URL('../' + f, self.location.href).href })
          .then(h => { highs = h; resolve(h) })
          .catch(reject)
      } catch (e) { reject(e) }
    })
  }
  return highsPromise
}

const post = (msg: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)

SCH.setSolverFactory(() => ({
  run: (lp: string, options: Record<string, unknown>) => getHighs().then(h => h.solve(lp, options)),
  close: () => { /* wasm 实例复用到本 worker 结束；主线程 terminate 时整块释放 */ }
}))
SCH.setProgressHook((stage: string, limit: number) => post({ type: 'progress', stage, limit }))

self.onmessage = async (ev: MessageEvent) => {
  const job = ev.data || {}
  try {
    const dates: Date[] = (job.dates as string[]).map(s => new Date(s))
    const base = { needNotes: job.needNotes || [], custom: job.custom || null }
    post({ type: 'progress', stage: 'build' })
    const input = SCH.buildInput(dates, job.people, job.rules, job.carry, base)
    post({ type: 'progress', stage: 'solve' })
    let res: SolveResult, note = ''
    try {
      const opts: Record<string, number> = {}
      if (job.stage1Limit) opts.stage1Limit = job.stage1Limit
      if (job.stage2Limit != null) opts.stage2Limit = job.stage2Limit
      res = await SCH.solveExact(input, opts)
      if (res && res.engine === 'highs') {
        note = '精确求解用时 ' + ((res.ms || 0) / 1000).toFixed(1) + ' 秒' + (res.status === 'Optimal' ? '' : '（已到时间上限，取当前最好方案）')
      }
    } catch (e) {
      // HiGHS 不可用（文件缺失 / 浏览器限制）→ 启发式兜底，仍在本 worker 内执行
      post({ type: 'progress', stage: 'fallback' })
      const hin = SCH.buildInput(dates, job.people, job.rules, job.carry, { ...base, heuristic: true })
      res = SCH.solve(hin)
      note = '⚠ 精确求解不可用（' + ((e as Error)?.message || e) + '），已改用备用算法，结果可能有违规'
      post({ type: 'done', input: hin, res, note })
      return
    }
    post({ type: 'done', input, res, note })
  } catch (e) {
    post({ type: 'error', message: (e as Error)?.message || String(e) })
  }
}
