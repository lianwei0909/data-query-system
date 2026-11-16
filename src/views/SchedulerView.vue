<script setup lang="ts">
// 智能排班：页面 DOM 与交互沿用 v1（scheduler-core.js 内的遗留渲染），求解交给 Worker（主线程不卡、可取消、有进度）
import { onBeforeUnmount, onMounted, ref, computed } from 'vue'
import SCH from '../solver/scheduler-core.js'
import { solveInWorker, cancelSolve, progress, progressText } from '../solver/useSolver'
import { loadXlsx } from '../core/xlsx'
import { toast } from '../core/notify'
import '../styles/scheduler.css'

const running = ref(false)
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
const pct = computed(() => {
  switch (progress.value) {
    case 'build': return 8
    case 'solve': return 15
    case 'stage1': return Math.min(70, 15 + elapsed.value * 2.2)      // 第 1 阶段最长 25 秒
    case 'stage2': return Math.min(96, 72 + (elapsed.value % 10) * 2.4) // 第 2 阶段最长 8 秒
    case 'fallback': return 50
    default: return 5
  }
})

function cancel() {
  cancelSolve()
}

onMounted(() => {
  // Excel 库按需加载：先在后台预载并注入；导出时若还没好，scheduler-core 会通过 loader 再等一次
  SCH.setXlsxLoader(loadXlsx)
  loadXlsx().then(x => SCH.setXlsx(x)).catch(() => { /* 导出时再提示 */ })
  SCH.setNotifier(toast)
  SCH.setRunner((job: Parameters<typeof solveInWorker>[0]) => {
    running.value = true; elapsed.value = 0
    timer = setInterval(() => { elapsed.value++ }, 1000)
    const cancelled = new Promise<{ cancelled: true }>(resolve => {
      const stop = setInterval(() => { if (progress.value === 'cancel') { clearInterval(stop); resolve({ cancelled: true }) } }, 200)
    })
    return Promise.race([solveInWorker(job), cancelled]).finally(() => {
      running.value = false
      if (timer) { clearInterval(timer); timer = null }
    })
  })
  SCH.init()
})
onBeforeUnmount(() => {
  if (SCH.isRunning()) cancelSolve()     // 离开页面时终止求解，释放 wasm 内存
  SCH.setRunner(null)
  if (timer) clearInterval(timer)
})
</script>

<template>
<div class="sub-page-body page-scheduler">
  <div class="container">
  
    <div class="page-intro">
      <h2>智能排班</h2>
      <p>填写每个人的请假 / 必休 / 指定班次，自动生成满足最低保障与人数上限的合规班表</p>
    </div>
  
    <!-- 周期与规则 -->
    <div class="upload-section">
      <div class="sch-row">
        <label>排班周期</label>
        <select id="period-year" aria-label="排班年份"></select>
        <select id="period-month" aria-label="排班月份"></select>
        <span class="sch-period-label" id="period-label"></span>
      </div>
      <div class="sch-rules">
        <span class="sch-field">最低白班 <input type="number" id="rule-minday" min="1" max="5" aria-label="最低白班人数" /></span>
        <span class="sch-field">最低夜班 <input type="number" id="rule-minnight" min="1" max="5" aria-label="最低夜班人数" /></span>
        <span class="sch-field">最多同时上班 <input type="number" id="rule-maxstaff" min="2" max="8" aria-label="最多同时上班人数" /></span>
        <span class="sch-field">最长连班 <input type="number" id="rule-maxrun" min="3" max="10" aria-label="最长连班天数" /></span>
        <span class="sch-field">每人上班天数 <input type="number" id="rule-target" min="1" max="31" aria-label="每人上班天数" /></span>
        <label class="sch-field" style="cursor:pointer"><input type="checkbox" id="rule-n2dh" style="width:auto" /> 小夜后次日不上白班（硬约束）</label>
        <button type="button" class="board-eraser" id="btn-reset">恢复默认规则</button>
      </div>
      <div class="hint-text" style="margin-top:10px">周期：上月 21 日 ~ 本月 20 日　·　小夜后次日不上白班　·　休息尽量连休两天</div>
    </div>
  
    <!-- 人员需求 -->
    <div class="preview-section active">
      <div class="section-title">人员需求</div>
      <div id="people-box" class="sch-people-wrap"></div>
      <div class="action-bar">
        <button type="button" class="btn-import" id="btn-run">⚡ 生成排班</button>
        <button type="button" class="btn btn-secondary" id="btn-again">🔄 换个排法</button>
        <button type="button" class="btn btn-secondary" id="btn-export">📥 导出 Excel</button>
        <button type="button" class="btn btn-secondary" id="btn-restore">恢复默认人员</button>
          <button v-if="running" type="button" class="btn btn-secondary sch-cancel" @click="cancel">⏹ 取消排班</button>
      </div>
      <div class="hint-text">
        一句话写需求，多条用逗号隔开，右侧「识别结果」可实时核对：<br />
        请假 <b>11月25日-27日年假</b>　·　休息 <b>8、9号休</b>　·　指定 <b>15号白班</b>　·　按星期 <b>周四周五休，周末白班，其余夜班</b>　·　偏好 <b>尽量少上夜班</b><br />
        最后一行「自定义需求」对全员生效，叠加在现有规则之上，多条用分号隔开：<br />
        全员 <b>12月31日不休</b>　·　每日人数 <b>每天白班至少3人</b>　·　点名 <b>张三：12月1日-2日年假</b>　·　天数 <b>夜班最多10天</b>
      </div>
    </div>
  
    <!-- 求解进度（Worker 实时回传） -->
    <div v-if="running" class="sch-progress" role="status" aria-live="polite">
      <div class="sch-progress-bar"><div class="sch-progress-fill" :style="{ width: pct + '%' }" /></div>
      <div class="sch-progress-text">{{ progressText || '正在排班…' }}　已用时 {{ elapsed }} 秒</div>
    </div>
    <!-- 结果 -->
    <div id="result-box" class="preview-section"></div>
    <div id="summary-box" class="preview-section"></div>
  </div>
  <div id="sch-notification" class="sch-notify"></div>
</div>
</template>

<style scoped>
.sch-progress { margin: 4px 0 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg); }
.sch-progress-bar { height: 6px; border-radius: 3px; background: var(--card-bg2); overflow: hidden; }
.sch-progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .6s ease; }
.sch-progress-text { margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
.sch-cancel { border-color: var(--red) !important; color: var(--red) !important; }
</style>
