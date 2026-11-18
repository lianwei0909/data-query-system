<script setup lang="ts">
// 排班结果表：两行表头、色块单元格、行统计条、筛选、图例。
// 契约：#result-box 内仍用 .sch-table；tbody 只有人员行；第 6 个 td 仍是第 5 个日期；tfoot 保留 .sch-cell.stat。
import { computed, ref } from 'vue'
import SCH from '../../solver/engine.js'
import type { DayStat, ScheduleResult, SchedulerInput } from '../../solver/types'

const props = defineProps<{ input: SchedulerInput; result: ScheduleResult }>()
const emit = defineEmits<{ (e: 'export'): void }>()
const dayNames = computed(() => [...new Set(props.input.dayLabel?.length ? props.input.dayLabel : ['白班'])])
const LEGEND: [string, string][] = [['白', 'day1'], ['夜', 'night'], ['休', 'rest'], ['假', 'leave']]
const cellCls = (v: string) => v === '小夜班3' ? 'night' : v === '休' ? 'rest' : dayNames.value.includes(v) ? 'day1' : 'leave'
const shortName = (v: string) => v === '小夜班3' ? '夜' : dayNames.value.includes(v) ? '白' : v
const STAT_ROWS: { label: string; get: (s: DayStat) => number; bad: (v: number) => boolean }[] = [
  { label: '白班人数', get: s => s.day, bad: v => v < props.input.rules.minDay },
  { label: '夜班人数', get: s => s.night, bad: v => v < props.input.rules.minNight },
  { label: '合计出勤', get: s => s.total, bad: v => v > props.input.rules.maxStaff }
]
const filter = ref<'all' | 'day' | 'night'>('all')
const FILTERS: { key: 'all' | 'day' | 'night'; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'day', label: '只看白班' }, { key: 'night', label: '只看夜班' }
]
const dateLabel = (d: Date, i: number) => i === 0 || d.getDate() === 1 ? `${d.getMonth() + 1}/${d.getDate()}` : String(d.getDate())
const weekLabel = (d: Date) => SCH.weekdayCn(d).replace('星期', '')
const total = (p: number) => {
  const s = props.result.personStats[p]
  return Math.max(1, s.day + s.night + s.rest + s.leave)
}
const share = (p: number, k: 'day' | 'night' | 'rest' | 'leave') => Math.round(props.result.personStats[p][k] / total(p) * 100)
</script>

<template>
  <div class="sch-toolbar">
    <div class="sch-filter">
      <button v-for="f in FILTERS" :key="f.key" type="button" :class="{ active: filter === f.key }" @click="filter = f.key">{{ f.label }}</button>
    </div>
    <div class="sch-legend">
      <span v-for="[name, cls] in LEGEND" :key="name" class="sch-legend-item"><i :class="'sch-dot ' + cls"></i><span>{{ name }}</span></span>
    </div>
    <button type="button" id="btn-export" class="sch-export" @click="emit('export')">📥 导出 Excel</button>
  </div>

  <div class="sch-table-wrap">
    <table class="sch-table" :class="'filter-' + filter">
      <thead>
        <tr class="sch-head-date">
          <th class="sch-name-col" rowspan="2">姓名</th>
          <th v-for="(d, i) in input.dates" :key="'d' + i" :class="[SCH.isWeekend(d) ? 'sch-we' : '', d.getDate() === 1 && i > 0 ? 'month-start' : '']"
            :title="SCH.keyOf(d) + ' ' + SCH.weekdayCn(d)">{{ dateLabel(d, i) }}</th>
          <th class="sch-sum-col" rowspan="2">本期统计</th>
        </tr>
        <tr class="sch-head-week">
          <th v-for="(d, i) in input.dates" :key="'w' + i" :class="SCH.isWeekend(d) ? 'sch-we' : ''">{{ weekLabel(d) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, p) in result.grid" :key="p">
          <td class="sch-name-col">
            <span class="sch-name-avatar">{{ input.people[p].cn.charAt(0) }}</span>
            <span class="sch-name-text"><b>{{ input.people[p].cn }}</b><small>{{ input.people[p].en }}</small></span>
          </td>
          <td v-for="(v, d) in row" :key="d" :class="'sch-cell ' + cellCls(v)" :title="SCH.keyOf(input.dates[d]) + ' ' + shortName(v)">
            <span class="sch-block">{{ shortName(v) }}</span>
          </td>
          <td class="sch-sum-col sch-person-stat">
            <div class="stat-bar">
              <i class="seg-day" :style="{ width: share(p, 'day') + '%' }"></i>
              <i class="seg-night" :style="{ width: share(p, 'night') + '%' }"></i>
              <i class="seg-rest" :style="{ width: share(p, 'rest') + '%' }"></i>
              <i class="seg-leave" :style="{ width: share(p, 'leave') + '%' }"></i>
            </div>
            <div class="stat-text">白 {{ result.personStats[p].day }} · 夜 {{ result.personStats[p].night }} · 休 {{ result.personStats[p].rest }} · 假 {{ result.personStats[p].leave }}</div>
            <div v-if="result.personStats[p].maxRun > input.rules.maxRun" class="stat-warn">连班 {{ result.personStats[p].maxRun }} 天超限</div>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr v-for="r in STAT_ROWS" :key="r.label" class="sch-stat-row">
          <td class="sch-name-col">{{ r.label }}</td>
          <td v-for="(s, d) in result.dayStats" :key="d" class="sch-cell stat" :class="{ bad: r.bad(r.get(s)) }">{{ r.get(s) }}</td>
          <td class="sch-sum-col"></td>
        </tr>
        <tr v-for="[label, duty] in ([['争议白班', result.dayDuty], ['争议夜班', result.nightDuty]] as [string, string[]][])" :key="label" class="sch-duty-row">
          <td class="sch-name-col">{{ label }}</td>
          <td v-for="(n, d) in duty" :key="d" class="sch-cell duty" :title="n">{{ n ? n.slice(0, 3) : '' }}</td>
          <td class="sch-sum-col"></td>
        </tr>
      </tfoot>
    </table>
  </div>
</template>
