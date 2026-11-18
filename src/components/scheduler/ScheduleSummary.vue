<script setup lang="ts">
// 结果区下半部：夜班均衡 + 校验明细（含跨期衔接、求解说明、违规项）。
// 保留 .sch-violations / .sch-violation / .sch-ok / .sch-tip / .sch-notes 与 e2e 依赖的两句话。
import { computed } from 'vue'
import type { CarryInfo, ScheduleResult, SchedulerInput, Validation } from '../../solver/types'

const props = defineProps<{ input: SchedulerInput; result: ScheduleResult; validation: Validation; carry: CarryInfo | null }>()
const errs = computed(() => props.validation.errors || [])
const solo = computed(() => props.validation.solo || [])
const notes = computed(() => (props.validation.notes || []).concat(props.input.needNotes || []))
const okText = computed(() => errs.value.length ? '' : '✅ 全部硬约束满足：白班、夜班、人数上限、出勤与连班都在规则内')
const carryText = computed(() => {
  const c = props.carry
  if (!c || !c.linked) return '⚠ 未找到上期班次：请先在「数据导入」导入包含上期最后几天的班表（或先排上一期），否则连班、夜班→白班、双休只在本期内检查'
  if (c.source === 'import') {
    return '已按「数据导入」的实际班表衔接上期最后 ' + c.days + ' 天（连班、夜班→白班、双休跨期生效）' +
      (c.missing && c.missing.length ? '；导入班表里没找到：' + c.missing.join('、') : '')
  }
  return c.gap === 1 ? '已衔接上一周期末尾班段（连班计数与夜班限制跨周期生效）' : '已衔接上一周期末尾班段（中间空档 ' + (c.gap - 1) + ' 天按休息处理）'
})
const nightText = computed(() => props.input.nightTarget
  ? '夜班分配参考往期习惯（实际/目标）：' + props.result.personStats.map((s, i) => s.cn + ' ' + s.night + '/' + props.input.nightTarget[i].toFixed(0)).join('　')
  : '')
const checks = computed(() => {
  const r = props.input.rules, ds = props.result.dayStats
  const minDay = ds.length ? Math.min(...ds.map(s => s.day)) : 0
  const minNight = ds.length ? Math.min(...ds.map(s => s.night)) : 0
  const maxTotal = ds.length ? Math.max(...ds.map(s => s.total)) : 0
  const maxRun = props.result.personStats.reduce((a, s) => Math.max(a, s.maxRun), 0)
  return [
    { label: '每天白班人数', value: `最少 ${minDay} 人 / 要求 ≥${r.minDay} 人` },
    { label: '每天夜班人数', value: `最少 ${minNight} 人 / 要求 ≥${r.minNight} 人` },
    { label: '同时上班人数', value: `最多 ${maxTotal} 人 / 上限 ${r.maxStaff} 人` },
    { label: '每人出勤天数', value: `目标 ${r.targetDays} 天（允许 ±1 浮动）` },
    { label: '最长连班', value: `${maxRun} 天 / 上限 ${r.maxRun} 天` },
    { label: '夜班后次日不上白班', value: r.nightToDayHard ? '硬约束' : '软约束' }
  ]
})
const targetOf = (i: number) => props.input.nightTarget ? Math.round(props.input.nightTarget[i]) : 0
const maxNight = computed(() => Math.max(1, ...props.result.personStats.map(s => s.night), ...props.result.personStats.map((_, i) => targetOf(i))))
const barWidth = (v: number) => Math.min(100, Math.round(v / maxNight.value * 100))
</script>

<template>
  <div class="summary-bottom">
    <section class="summary-panel">
      <h3 class="summary-title">夜班均衡 <small>竖线为往期习惯目标</small></h3>
      <div v-for="(st, i) in result.personStats" :key="st.en + st.cn" class="balance-row">
        <span class="balance-name">{{ st.cn }}</span>
        <div class="balance-track">
          <div class="balance-fill" :style="{ width: barWidth(st.night) + '%' }"></div>
          <i class="balance-target" :style="{ left: barWidth(targetOf(i)) + '%' }" :title="'目标 ' + targetOf(i) + ' 次'"></i>
        </div>
        <span class="balance-num">{{ st.night }} / {{ targetOf(i) }}<b v-if="st.night !== targetOf(i)" :class="st.night > targetOf(i) ? 'over' : 'under'">{{ st.night > targetOf(i) ? '+' : '' }}{{ st.night - targetOf(i) }}</b></span>
      </div>
    </section>

    <section class="summary-panel">
      <h3 class="summary-title">校验明细 <small>6 项硬约束</small></h3>
      <div v-if="errs.length" class="sch-violations">
        <div v-for="(v, i) in errs.slice(0, 20)" :key="i" class="sch-violation">⚠ {{ v }}</div>
        <div v-if="errs.length > 20" class="sch-violation">…还有 {{ errs.length - 20 }} 项</div>
      </div>
      <div v-if="solo.length" class="sch-violations">
        <div class="sch-violation">△ 以下 {{ solo.length }} 处单休（双休实在排不开，已尽量避免）：{{ solo.join('、') }}</div>
      </div>
      <div v-if="okText" class="sch-ok">{{ okText }}</div>
      <div v-for="(c, i) in checks" :key="i" class="check-item"><span>✓</span>{{ c.label }}<small>{{ c.value }}</small></div>
      <div class="sch-tip">{{ carryText }}</div>
      <div v-if="nightText" class="sch-tip">{{ nightText }}</div>
      <div v-if="notes.length" class="sch-notes">
        <div v-for="(n, i) in notes" :key="i" class="sch-note">· {{ n }}</div>
      </div>
      <div class="sch-tip">可以多点几次「换个排法」，挑一个违规为 0 的方案</div>
    </section>
  </div>
</template>
