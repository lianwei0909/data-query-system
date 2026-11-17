<script setup lang="ts">
// 智能排班：v2.1 页面全部改为 Vue 组件（规则 / 人员需求 / 结果表 / 校验报告），状态与持久化见 schedulerStore.ts，
// 算法在 engine.js（主线程只做结果整理与校验，求解交给 Worker：不卡界面、可取消、有进度）
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import SCH from '../solver/engine.js'
import type { CarryInfo, Person, RuleNumKey, Rules, ScheduleResult, SchedulerInput, SolveResult, Validation } from '../solver/types'
import { solveInWorker, cancelSolve, progress, progressText } from '../solver/useSolver'
import * as S from '../solver/schedulerStore'
import { loadShiftRows } from '../core/shiftStore'
import { browserStorage as ls } from '../core/storage'
import { loadXlsx } from '../core/xlsx'
import { toast } from '../core/notify'
import RulesPanel from '../components/scheduler/RulesPanel.vue'
import PeopleTable from '../components/scheduler/PeopleTable.vue'
import ScheduleTable from '../components/scheduler/ScheduleTable.vue'
import ScheduleSummary from '../components/scheduler/ScheduleSummary.vue'
import '../styles/scheduler.css'

// 与 v1 一致：每次用到班表时重新读取存储（在别的标签页导入后切回本页也能拿到最新人员与上期班次）
const rows = () => loadShiftRows() as S.Row[]
const now = new Date()
const years = S.yearOptions(now)
const period = ref(S.defaultPeriod(now))
const dates = computed(() => SCH.periodDates(period.value.year, period.value.month))
const periodText = computed(() => S.periodLabel(dates.value))

const people = ref<Person[]>(S.loadPeople(rows(), ls))
const rules = ref<Rules>(S.loadRules(ls))
const customText = ref(S.loadCustom(ls))
watch(people, v => S.savePeople(v, ls), { deep: true })
watch(customText, v => S.saveCustom(v, ls))

interface Last { input: SchedulerInput; result: ScheduleResult; validation: Validation; carry: CarryInfo }
const last = shallowRef<Last | null>(null)       // 结果数组较大，不做深层响应式
const message = ref('')                           // 结果区提示：排班中 / 已取消 / 出错
const running = ref(false)
const elapsed = ref(0)
const resultBox = ref<HTMLElement | null>(null)
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

// ── 规则 / 人员 ──
function setRule(key: RuleNumKey, v: number) {
  if (!isNaN(v) && v > 0) { rules.value[key] = v; S.saveRules(rules.value, ls) }
}
function setN2D(v: boolean) {
  rules.value.nightToDayHard = v
  S.saveRules(rules.value, ls)
  toast(v ? '已把夜班约束设为硬约束（可能击穿白班下限）' : '已把夜班约束设为软约束（优先保证人数与双休）')
}
function setFixedRest(v: boolean) {
  rules.value.fixedRest = v
  S.saveRules(rules.value, ls)
  toast(v ? '已开启固定轮休：每人每周尽量休同样的两天（参考往期班表）' : '已关闭固定轮休：休息日按人数与连休自由安排')
}
function resetRules() {
  rules.value = S.defaultRules()
  S.saveRules(rules.value, ls)
  toast('规则已恢复默认')
}
function restorePeople() {
  // 「恢复默认」= 按已导入的班表重新提取人员（源码里不预置名单）
  people.value = S.peopleFromImported(rows())
  toast(people.value.length ? '已按导入的班表重新提取 ' + people.value.length + ' 人' : '还没有导入班表，请先在「数据导入」导入',
    people.value.length ? 'success' : 'error')
}

// ── 排班 ──
async function run() {
  const r = rules.value
  const actives = people.value.filter(p => p.active)
  if (!actives.length) { toast('请至少勾选一位参与排班的人', 'error'); return }
  if (actives.length < r.minDay + r.minNight) { toast('参与人数少于每日最低保障人数', 'error'); return }
  if (running.value) return
  running.value = true
  elapsed.value = 0
  timer = setInterval(() => { elapsed.value++ }, 1000)
  message.value = '⏳ 正在排班（精确求解，通常 5~30 秒）…'
  await nextTick()
  try { resultBox.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch { /* 老浏览器 */ }

  const ds = dates.value
  // 去掉响应式代理：Worker 的 postMessage 需要可结构化克隆的纯对象
  const plain = JSON.parse(JSON.stringify(actives)) as Person[]
  const needNotes: string[] = [], invalid: string[] = []
  plain.forEach(p => {
    const n = SCH.parseNeedText(p.need, ds)
    n.invalid.forEach(x => invalid.push(p.cn + '：' + x))
    n.notes.forEach(x => needNotes.push(p.cn + '：' + x))
  })
  const custom = SCH.parseCustomNeed(customText.value || '', ds, people.value)
  custom.invalid.forEach(x => invalid.push('自定义需求：' + x))
  const carry = S.loadCarry(plain, ds, rows(), ls)
  try {
    const out = await solveInWorker({ dates: ds, people: plain, rules: { ...r }, carry: carry.carry, needNotes, custom })
    if ('cancelled' in out) { message.value = '已取消本次排班'; toast('已取消排班', 'error'); return }
    show(out.input, out.res, out.note, invalid, carry, plain)
  } catch (err) {
    message.value = '❌ 求解出错：' + ((err as Error)?.message || String(err))
  } finally {
    running.value = false
    if (timer) { clearInterval(timer); timer = null }
  }
}
function show(input: SchedulerInput, res: SolveResult, note: string, invalid: string[], carry: CarryInfo, actives: Person[]) {
  if (!res.a) {
    message.value = '❌ ' + (res.reason || '无解')
    last.value = null
    toast(res.reason || '无解', 'error')
    return
  }
  const result = SCH.buildResult(input, res.a)
  const validation = SCH.validate(input, result)
  if (note) validation.notes.unshift(note)
  if (invalid.length) validation.notes.unshift('需求里有内容没识别，已忽略：' + invalid.join('；'))
  last.value = { input, result, validation, carry }
  message.value = ''
  S.saveLast(input.dates, actives, res.a, ls)
  const f = S.finishMessage(validation.errors.length, validation.solo.length)
  toast(f.msg, f.type)
}
function cancel() { cancelSolve() }

// ── 导出 ──
async function doExport() {
  const L = last.value
  if (!L) { toast('请先生成排班', 'error'); return }
  const name = S.exportFileName(L.input.dates)
  try { SCH.setXlsx(await loadXlsx()) } catch (e) {
    toast('导出失败：' + ((e as Error)?.message || 'Excel 库加载失败'), 'error')
    return
  }
  const ok = SCH.exportXlsx(L.input, L.result, name)
  toast(ok ? '已导出 ' + name : '导出失败：缺少 XLSX 库', ok ? 'success' : 'error')
}

onMounted(() => {
  // Excel 库后台预载；导出时若还没好会再等一次
  loadXlsx().then(x => SCH.setXlsx(x)).catch(() => { /* 导出时再提示 */ })
})
onBeforeUnmount(() => {
  if (running.value) cancelSolve()     // 离开页面时终止求解，释放 wasm 内存
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

      <RulesPanel
        v-model:year="period.year" v-model:month="period.month" :years="years" :period-text="periodText" :rules="rules"
        @rule="setRule" @n2d="setN2D" @fixed-rest="setFixedRest" @reset="resetRules"
      />

      <!-- 人员需求 -->
      <div class="preview-section active">
        <div class="section-title">人员需求</div>
        <PeopleTable
          v-model:custom-text="customText" :people="people" :dates="dates"
          @active="(i, v) => (people[i].active = v)" @need="(i, v) => (people[i].need = v)"
        />
        <div class="action-bar">
          <button type="button" class="btn-import" id="btn-run" :disabled="running" @click="run">{{ running ? '排班中…' : '⚡ 生成排班' }}</button>
          <button type="button" class="btn btn-secondary" id="btn-again" :disabled="running" title="换一组随机起点重排" @click="run">🔄 换个排法</button>
          <button type="button" class="btn btn-secondary" id="btn-export" @click="doExport">📥 导出 Excel</button>
          <button type="button" class="btn btn-secondary" id="btn-restore" @click="restorePeople">恢复默认人员</button>
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
      <div id="result-box" ref="resultBox" class="preview-section" :class="{ active: !!message || !!last }">
        <div v-if="message" class="sch-empty">{{ message }}</div>
        <ScheduleTable v-else-if="last" :input="last.input" :result="last.result" />
      </div>
      <div id="summary-box" class="preview-section" :class="{ active: !!last && !message }">
        <ScheduleSummary v-if="last && !message" :input="last.input" :result="last.result" :validation="last.validation" :carry="last.carry" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sch-progress { margin: 4px 0 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg); }
.sch-progress-bar { height: 6px; border-radius: 3px; background: var(--card-bg2); overflow: hidden; }
.sch-progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .6s ease; }
.sch-progress-text { margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
.sch-cancel { border-color: var(--red) !important; color: var(--red-text) !important; }
</style>
