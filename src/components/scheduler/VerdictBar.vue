<script setup lang="ts">
// 结果区第一行：合规结论 + 4 个关键数字（数据全部来自现有 validation / result，不新增计算）
import { computed } from 'vue'
import type { ScheduleResult, SchedulerInput, Validation } from '../../solver/types'

const props = defineProps<{ input: SchedulerInput; result: ScheduleResult; validation: Validation; notes: string[] }>()
const errs = computed(() => props.validation.errors || [])
const avg = (get: (s: { day: number; night: number }) => number) => {
  const ds = props.result.dayStats
  return ds.length ? (ds.reduce((a, s) => a + get(s), 0) / ds.length).toFixed(1) : '0'
}
const avgDay = computed(() => avg(s => s.day))
const avgNight = computed(() => avg(s => s.night))
const maxRun = computed(() => props.result.personStats.reduce((a, s) => Math.max(a, s.maxRun), 0))
const fallback = computed(() => (props.notes || []).some(n => n.includes('精确求解不可用')))
const timing = computed(() => {
  const hit = (props.notes || []).find(n => n.includes('精确求解用时'))
  return hit ? (hit.match(/精确求解用时\s*([\d.]+\s*秒)/)?.[1] || '—') : (fallback.value ? '备用算法' : '—')
})
</script>

<template>
  <div class="verdict-bar" :class="errs.length ? 'is-bad' : 'is-ok'">
    <div class="verdict-main">
      <span class="verdict-icon">{{ errs.length ? '!' : '✓' }}</span>
      <span class="verdict-text">
        <b>{{ errs.length ? `有 ${errs.length} 项不满足规则` : '全部硬约束满足' }}</b>
        <small>{{ errs.length ? '先看下方校验明细，或点「换个排法」重排' : '白班 / 夜班 / 连班 / 休息节奏都在规则内' }}</small>
      </span>
      <span v-if="fallback" class="verdict-tag" title="精确求解不可用，已改用备用算法">备用算法</span>
    </div>
    <div class="verdict-nums">
      <div><b>{{ input.rules.targetDays }}</b><span>每人出勤 / 天</span></div>
      <div><b>{{ avgDay }} / {{ avgNight }}</b><span>日均白 / 夜人数</span></div>
      <div><b>{{ maxRun }}</b><span>最长连班 / 天</span></div>
      <div><b>{{ timing }}</b><span>求解用时</span></div>
    </div>
  </div>
</template>
