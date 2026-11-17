<script setup lang="ts">
// 排班结果表：每人每天班次 + 个人合计 + 每日人数统计 + 争议值班轮值 + 图例
import { computed } from 'vue'
import SCH from '../../solver/engine.js'
import type { DayStat, ScheduleResult, SchedulerInput } from '../../solver/types'

const props = defineProps<{ input: SchedulerInput; result: ScheduleResult }>()
const SUM_HEADS = ['出勤', '休', '白班', '夜班', '最长连班']
// 界面统一称呼：白班类显示「白」，夜班显示「夜」；底层班次名（往期写法）保持不变
const dayNames = computed(() => [...new Set(props.input.dayLabel?.length ? props.input.dayLabel : ['白班'])])
const LEGEND: [string, string][] = [['白', 'day1'], ['夜', 'night'], ['休', 'rest'], ['假', 'leave']]
const cellCls = (v: string) => v === '小夜班3' ? 'night' : v === '休' ? 'rest' : dayNames.value.includes(v) ? 'day1' : 'leave'
const shortName = (v: string) => v === '小夜班3' ? '夜' : dayNames.value.includes(v) ? '白' : v
const STAT_ROWS: { label: string; get: (s: DayStat) => number; bad: (v: number) => boolean }[] = [
  { label: '白班', get: s => s.day, bad: v => v < props.input.rules.minDay },
  { label: '夜班', get: s => s.night, bad: v => v < props.input.rules.minNight },
  { label: '合计', get: s => s.total, bad: v => v > props.input.rules.maxStaff }
]
</script>

<template>
  <div class="sch-table-wrap">
    <table class="sch-table">
      <thead>
        <tr>
          <th class="sch-name-col">姓名</th>
          <th v-for="(d, i) in input.dates" :key="i" :class="SCH.isWeekend(d) ? 'sch-we' : ''" :title="SCH.keyOf(d) + ' ' + SCH.weekdayCn(d)">{{ d.getDate() }}</th>
          <th v-for="t in SUM_HEADS" :key="t" class="sch-sum-col">{{ t }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, p) in result.grid" :key="p">
          <td class="sch-name-col">{{ input.people[p].cn }}</td>
          <td v-for="(v, d) in row" :key="d" :class="'sch-cell ' + cellCls(v)" :title="SCH.keyOf(input.dates[d]) + ' ' + shortName(v)">{{ shortName(v) }}</td>
          <td class="sch-sum-col">{{ result.personStats[p].work }}</td>
          <td class="sch-sum-col">{{ result.personStats[p].rest }}</td>
          <td class="sch-sum-col">{{ result.personStats[p].day }}</td>
          <td class="sch-sum-col">{{ result.personStats[p].night }}</td>
          <td class="sch-sum-col" :class="{ bad: result.personStats[p].maxRun > input.rules.maxRun }">{{ result.personStats[p].maxRun }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr v-for="r in STAT_ROWS" :key="r.label" class="sch-stat-row">
          <td class="sch-name-col">{{ r.label }}</td>
          <td v-for="(s, d) in result.dayStats" :key="d" class="sch-cell stat" :class="{ bad: r.bad(r.get(s)) }">{{ r.get(s) }}</td>
          <td v-for="k in 5" :key="'e' + k" class="sch-sum-col"></td>
        </tr>
        <tr v-for="[label, duty] in ([['争议白班', result.dayDuty], ['争议夜班', result.nightDuty]] as [string, string[]][])" :key="label" class="sch-duty-row">
          <td class="sch-name-col">{{ label }}</td>
          <td v-for="(n, d) in duty" :key="d" class="sch-cell duty">{{ n ? n.slice(0, 3) : '' }}</td>
          <td v-for="k in 5" :key="'e' + k" class="sch-sum-col"></td>
        </tr>
      </tfoot>
    </table>
  </div>
  <div class="sch-legend">
    <span v-for="[name, cls] in LEGEND" :key="name" class="sch-legend-item"><i :class="'sch-dot ' + cls"></i><span>{{ name }}</span></span>
  </div>
</template>
