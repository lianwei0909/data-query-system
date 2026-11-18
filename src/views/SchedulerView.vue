<script setup lang="ts">
// 智能排班：双栏工作台（左配置 / 右结果）。求解、校验、导出逻辑保持原样，进度交给 Worker。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
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
import VerdictBar from '../components/scheduler/VerdictBar.vue'
import SolveProgress from '../components/scheduler/SolveProgress.vue'
import '../styles/scheduler.css'

const router = useRouter()
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
const activeCount = computed(() => people.value.filter(p => p.active).length)

interface Last { input: SchedulerInput; result: ScheduleResult; validation: Validation; carry: CarryInfo }
const last = shallowRef<Last | null>(null)
const message = ref('')
const running = ref(false)
const elapsed = ref(0)
const resultBox = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const pct = computed(() => {
  switch (progress.value) {
    case 'build': return 8
    case 'solve': return 15
    case 'stage1': return Math.min(70, 15 + elapsed.value * 2.2)
    case 'stage2': return Math.min(96, 72 + (elapsed.value % 10) * 2.4)
    case 'fallback': return 50
    default: return 5
  }
})

function setRule(key: RuleNumKey, v: number) {
  if (!isNaN(v) && v > 0) { rules.value[key] = v; S.saveRules(rules.value, ls) }
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
  people.value = S.peopleFromImported(rows())
  toast(people.value.length ? '已按导入的班表重新提取 ' + people.value.length + ' 人' : '还没有导入班表，请先在「数据导入」导入',
    people.value.length ? 'success' : 'error')
}

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

  const ds = dates.value
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
function primary() { people.value.length ? run() : router.push('/import') }
const EXAMPLES = ['周四周五休，周末白班', '11月25日-27日年假', '尽量少上夜班', '每天白班至少3人']
const useExample = (t: string) => { customText.value = customText.value ? customText.value + '；' + t : t }

onMounted(() => { loadXlsx().then(x => SCH.setXlsx(x)).catch(() => { /* 导出时再提示 */ }) })
onBeforeUnmount(() => {
  if (running.value) cancelSolve()
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="sub-page-body page-scheduler">
    <div class="container">
      <div class="page-intro sch-page-intro">
        <h2>智能排班</h2>
        <p>左侧改规则与需求，右侧直接看合规结论和全月班表</p>
      </div>

      <div class="sch-workbench">
        <!-- 左栏：配置 -->
        <aside class="sch-config">
          <div class="sch-config-scroll">
            <RulesPanel
              v-model:year="period.year" v-model:month="period.month" :years="years" :period-text="periodText" :rules="rules"
              @rule="setRule" @fixed-rest="setFixedRest" @reset="resetRules"
            />
            <div class="cfg-card people-card">
              <div class="cfg-head">
                <span class="cfg-title">人员需求</span>
                <span class="cfg-hint">参与 {{ activeCount }}/{{ people.length }}</span>
              </div>
              <PeopleTable
                v-model:custom-text="customText" :people="people" :dates="dates"
                @active="(i, v) => (people[i].active = v)" @need="(i, v) => (people[i].need = v)"
              />
            </div>
          </div>

          <!-- 固定在左栏底部的主操作 -->
          <div class="sch-action-bar">
            <button type="button" id="btn-run" class="btn-primary-main" :disabled="running" @click="primary">
              {{ running ? '排班中…' : (people.length ? '⚡ 生成排班' : '去导入班表') }}
            </button>
            <button type="button" id="btn-again" class="btn-secondary-action" :disabled="running" @click="run">🔄 换个排法</button>
            <details class="more-menu">
              <summary aria-label="更多操作">⋯</summary>
              <div class="menu-items">
                <button type="button" id="btn-restore" @click="restorePeople">按导入班表重新提取人员</button>
              </div>
            </details>
          </div>
        </aside>

        <!-- 右栏：结果 -->
        <section class="sch-right">
          <div v-if="running" class="sch-stage">
            <SolveProgress :pct="pct" :stage="progress" :text="progressText" :elapsed="elapsed" @cancel="cancel" />
          </div>
          <div v-else-if="message" class="sch-stage sch-empty">{{ message }}</div>
          <div v-else-if="!last" class="sch-stage sch-empty-state">
            <span class="empty-icon">▦</span>
            <h3>还没有排班结果</h3>
            <p>在左侧填好规则与人员需求，点「⚡ 生成排班」，合规结论和全月班表会出现在这里</p>
            <div class="empty-examples">
              <button v-for="t in EXAMPLES" :key="t" type="button" @click="useExample(t)">{{ t }}</button>
            </div>
          </div>

          <div id="summary-box" class="preview-section" :class="{ active: !!last && !message }">
            <VerdictBar v-if="last && !message" :input="last.input" :result="last.result" :validation="last.validation" :notes="last.validation.notes" />
            <div id="result-box" ref="resultBox" class="sch-result-box">
              <ScheduleTable v-if="last && !message" :input="last.input" :result="last.result" @export="doExport" />
            </div>
            <ScheduleSummary v-if="last && !message" :input="last.input" :result="last.result" :validation="last.validation" :carry="last.carry" />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
