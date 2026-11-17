<script setup lang="ts">
// 校验报告：硬约束违规 / 单休 / 跨期衔接说明 / 夜班分配 / 需求提示 / 个人统计
import { computed } from 'vue'
import type { CarryInfo, ScheduleResult, SchedulerInput, Validation } from '../../solver/types'

const props = defineProps<{ input: SchedulerInput; result: ScheduleResult; validation: Validation; carry: CarryInfo | null }>()
const errs = computed(() => props.validation.errors || [])
const solo = computed(() => props.validation.solo || [])
const notes = computed(() => (props.validation.notes || []).concat(props.input.needNotes || []))
const okText = computed(() => {
  const r = props.input.rules
  return '✅ 全部硬约束满足：白班≥' + r.minDay + '、夜班≥' + r.minNight + '、同时上班≤' + r.maxStaff + '、每人出勤' + r.targetDays +
    '天、连班≤' + r.maxRun + '、小夜后不上白班' + (solo.value.length ? '' : '、休息均为连续两天（双休）')
})
const carryText = computed(() => {
  const c = props.carry
  if (!c || !c.linked) return '⚠ 未找到上期班次：请先在「数据导入」导入包含上期最后几天的班表（或先排上一期），否则连班、小夜→白班、双休只在本期内检查'
  if (c.source === 'import') {
    return '已按「数据导入」的实际班表衔接上期最后 ' + c.days + ' 天（连班、小夜→白班、双休跨期生效）' +
      (c.missing && c.missing.length ? '；导入班表里没找到：' + c.missing.join('、') : '')
  }
  return c.gap === 1 ? '已衔接上一周期末尾班段（连班计数与小夜限制跨周期生效）' : '已衔接上一周期末尾班段（中间空档 ' + (c.gap - 1) + ' 天按休息处理）'
})
const nightText = computed(() => props.input.nightTarget
  ? '夜班分配参考往期习惯（实际/目标）：' + props.result.personStats.map((s, i) => s.cn + ' ' + s.night + '/' + props.input.nightTarget[i].toFixed(0)).join('　')
  : '')
</script>

<template>
  <div class="sch-sum-title">校验报告</div>
  <template v-if="errs.length">
    <div class="sch-violations">
      <div v-for="(v, i) in errs.slice(0, 20)" :key="i" class="sch-violation">⚠ {{ v }}</div>
      <div v-if="errs.length > 20" class="sch-violation">…还有 {{ errs.length - 20 }} 项</div>
    </div>
    <div class="sch-tip">可以多点几次「换个排法」，挑一个违规为 0 的方案</div>
  </template>
  <div v-else class="sch-ok">{{ okText }}</div>
  <div v-if="solo.length" class="sch-violations">
    <div class="sch-violation">△ 以下 {{ solo.length }} 处单休（双休实在排不开，已尽量避免）：{{ solo.join('、') }}</div>
  </div>
  <div class="sch-tip">{{ carryText }}</div>
  <div v-if="nightText" class="sch-tip">{{ nightText }}</div>
  <div v-if="notes.length" class="sch-notes">
    <div v-for="(n, i) in notes" :key="i" class="sch-note">· {{ n }}</div>
  </div>
  <table class="sch-table sch-mini">
    <tbody>
      <tr><th v-for="t in ['姓名', '出勤', '休', '假', '白班', '小夜', '周末班', '最长连班']" :key="t">{{ t }}</th></tr>
      <tr v-for="st in result.personStats" :key="st.en + st.cn">
        <td>{{ st.cn }}</td><td>{{ st.work }}</td><td>{{ st.rest }}</td><td>{{ st.leave ? st.leave : '-' }}</td>
        <td>{{ st.day }}</td><td>{{ st.night }}</td><td>{{ st.weekend }}</td><td>{{ st.maxRun }}</td>
      </tr>
    </tbody>
  </table>
</template>
