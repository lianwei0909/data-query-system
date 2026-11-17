<script setup lang="ts">
// 排班周期 + 规则（最低白/夜班、人数上限、连班上限、目标天数、夜班约束）
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
const FIELDS: { key: RuleNumKey; label: string; aria: string; min: number; max: number; id: string }[] = [
  { key: 'minDay', label: '最低白班', aria: '最低白班人数', min: 1, max: 5, id: 'rule-minday' },
  { key: 'minNight', label: '最低夜班', aria: '最低夜班人数', min: 1, max: 5, id: 'rule-minnight' },
  { key: 'maxStaff', label: '最多同时上班', aria: '最多同时上班人数', min: 2, max: 8, id: 'rule-maxstaff' },
  { key: 'maxRun', label: '最长连班', aria: '最长连班天数', min: 3, max: 10, id: 'rule-maxrun' },
  { key: 'targetDays', label: '每人上班天数', aria: '每人上班天数', min: 1, max: 31, id: 'rule-target' }
]
const onRule = (key: RuleNumKey, e: Event) => emit('rule', key, parseInt((e.target as HTMLInputElement).value, 10))
</script>

<template>
  <div class="upload-section">
    <div class="sch-row">
      <label for="period-year">排班周期</label>
      <select id="period-year" v-model.number="year" aria-label="排班年份">
        <option v-for="y in years" :key="y" :value="y">{{ y }}年</option>
      </select>
      <select id="period-month" v-model.number="month" aria-label="排班月份">
        <option v-for="m in 12" :key="m" :value="m">{{ m }}月</option>
      </select>
      <span class="sch-period-label" id="period-label">{{ periodText }}</span>
    </div>
    <div class="sch-rules">
      <span v-for="f in FIELDS" :key="f.key" class="sch-field">
        {{ f.label }}
        <input type="number" :id="f.id" :min="f.min" :max="f.max" :value="rules[f.key]" :aria-label="f.aria" @change="onRule(f.key, $event)" />
      </span>
      <label class="sch-field" style="cursor:pointer">
        <input type="checkbox" id="rule-n2dh" style="width:auto" :checked="rules.nightToDayHard" @change="emit('n2d', ($event.target as HTMLInputElement).checked)" />
        夜班后次日不上白班（硬约束）
      </label>
      <label class="sch-field" style="cursor:pointer" title="每人每周固定休息相邻两天（如周六日），优先沿用往期班表里各自的休息日；同时尽量让每周节奏一致、不排只上一天的孤立班">
        <input type="checkbox" id="rule-fixedrest" style="width:auto" :checked="rules.fixedRest !== false" @change="emit('fixedRest', ($event.target as HTMLInputElement).checked)" />
        每人固定轮休（参考往期）
      </label>
      <button type="button" class="board-eraser" id="btn-reset" @click="emit('reset')">恢复默认规则</button>
    </div>
    <div class="hint-text" style="margin-top:10px">周期：上月 21 日 ~ 本月 20 日　·　夜班后次日不上白班　·　休息尽量连休两天　·　固定轮休时每人每周休同样的两天</div>
  </div>
</template>
