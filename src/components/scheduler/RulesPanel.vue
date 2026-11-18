<script setup lang="ts">
// 排班周期 + 规则：分段周期切换、带单位步进器、开关。所有 e2e 依赖的 id 保持原位。
import { computed } from 'vue'
import type { RuleNumKey, Rules } from '../../solver/types'

const props = defineProps<{ year: number; month: number; years: number[]; periodText: string; rules: Rules }>()
const emit = defineEmits<{
  (e: 'update:year', v: number): void
  (e: 'update:month', v: number): void
  (e: 'rule', key: RuleNumKey, v: number): void
  (e: 'n2d', v: boolean): void
  (e: 'fixedRest', v: boolean): void
  (e: 'reset'): void
}>()
const year = computed({ get: () => props.year, set: v => emit('update:year', v) })
const month = computed({ get: () => props.month, set: v => emit('update:month', v) })
const FIELDS: { key: RuleNumKey; label: string; aria: string; min: number; max: number; id: string; unit: string }[] = [
  { key: 'minDay', label: '最低白班', aria: '最低白班人数', min: 1, max: 5, id: 'rule-minday', unit: '人' },
  { key: 'minNight', label: '最低夜班', aria: '最低夜班人数', min: 1, max: 5, id: 'rule-minnight', unit: '人' },
  { key: 'maxStaff', label: '同时上班上限', aria: '最多同时上班人数', min: 2, max: 8, id: 'rule-maxstaff', unit: '人' },
  { key: 'maxRun', label: '最长连班', aria: '最长连班天数', min: 3, max: 10, id: 'rule-maxrun', unit: '天' },
  { key: 'targetDays', label: '每人上班', aria: '每人上班天数', min: 1, max: 31, id: 'rule-target', unit: '天' }
]
const onRule = (key: RuleNumKey, e: Event) => emit('rule', key, parseInt((e.target as HTMLInputElement).value, 10))
function step(id: string, key: RuleNumKey, delta: number, min: number, max: number) {
  const el = document.getElementById(id) as HTMLInputElement | null
  if (!el) return
  const cur = parseInt(el.value, 10)
  const v = Math.min(max, Math.max(min, (isNaN(cur) ? props.rules[key] : cur) + delta))
  el.value = String(v)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
function shiftPeriod(delta: number) {
  let m = props.month + delta, y = props.year
  if (m > 12) { m = 1; y++ }
  if (m < 1) { m = 12; y-- }
  emit('update:month', m); emit('update:year', y)
}
</script>

<template>
  <div class="cfg-card">
    <div class="cfg-head">
      <span class="cfg-title">排班周期</span>
      <button type="button" id="btn-reset" class="cfg-reset" @click="emit('reset')">恢复默认规则</button>
    </div>
    <div class="period-switch">
      <button type="button" aria-label="上一个月" @click="shiftPeriod(-1)">‹</button>
      <div class="period-main">
        <span id="period-label" class="period-label">{{ periodText }}</span>
        <span class="period-sub">上月 21 日 ~ 本月 20 日</span>
      </div>
      <button type="button" aria-label="下一个月" @click="shiftPeriod(1)">›</button>
    </div>
    <div class="period-selects">
      <label>年
        <select id="period-year" v-model.number="year" aria-label="排班年份"><option v-for="y in years" :key="y" :value="y">{{ y }} 年</option></select>
      </label>
      <label>月
        <select id="period-month" v-model.number="month" aria-label="排班月份"><option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option></select>
      </label>
    </div>

    <div class="cfg-head"><span class="cfg-title">排班规则</span><span class="cfg-hint">改完随手点「生成排班」</span></div>
    <div class="stepper-grid">
      <div v-for="f in FIELDS" :key="f.key" class="stepper">
        <span class="stepper-label">{{ f.label }}<small>{{ f.unit }}</small></span>
        <div class="stepper-ctrl">
          <button type="button" :aria-label="f.label + '减一'" @click="step(f.id, f.key, -1, f.min, f.max)">−</button>
          <input type="number" :id="f.id" :min="f.min" :max="f.max" :value="rules[f.key]" :aria-label="f.aria" @change="onRule(f.key, $event)" />
          <button type="button" :aria-label="f.label + '加一'" @click="step(f.id, f.key, 1, f.min, f.max)">＋</button>
        </div>
      </div>
      <div class="stepper stepper-static">
        <span class="stepper-label">周期规则</span>
        <div class="stepper-value">21 → 20 日</div>
      </div>
    </div>

    <div class="switch-row">
      <label class="switch-item">
        <span class="switch-text"><b>夜班后次日不上白班</b><small>硬约束，可能压缩白班人数</small></span>
        <input type="checkbox" id="rule-n2dh" :checked="rules.nightToDayHard" @change="emit('n2d', ($event.target as HTMLInputElement).checked)" />
        <i class="switch-track" aria-hidden="true"></i>
      </label>
      <label class="switch-item">
        <span class="switch-text"><b>每人固定轮休</b><small>参考往期班表，每周休同样的两天</small></span>
        <input type="checkbox" id="rule-fixedrest" :checked="rules.fixedRest !== false" @change="emit('fixedRest', ($event.target as HTMLInputElement).checked)" />
        <i class="switch-track" aria-hidden="true"></i>
      </label>
    </div>
  </div>
</template>
