<script setup lang="ts">
// 人员需求：卡片式列表 + 彩色识别标签。保留 <table>/<tr> 语义与全部 e2e 选择器（方案 A）。
import { computed, ref } from 'vue'
import SCH from '../../solver/engine.js'
import { needChips } from '../../solver/schedulerStore'
import type { Person } from '../../solver/types'

const props = defineProps<{ people: Person[]; customText: string; dates: Date[] | null }>()
const emit = defineEmits<{
  (e: 'active', index: number, v: boolean): void
  (e: 'need', index: number, v: string): void
  (e: 'update:customText', v: string): void
}>()
const parsed = computed(() => props.people.map(p => SCH.parseNeedText(p.need || '', props.dates)))
const previews = computed(() => parsed.value.map(n => SCH.describeNeed(n) || '—'))
const chips = computed(() => parsed.value.map(n => needChips(n)))
const customPreview = computed(() => SCH.describeCustom(SCH.parseCustomNeed(props.customText || '', props.dates, props.people)) || '—')
const expanded = ref<Record<number, boolean>>({})
const shown = (i: number) => expanded.value[i] ? chips.value[i] : chips.value[i].slice(0, 2)
const toggle = (i: number) => { expanded.value = { ...expanded.value, [i]: !expanded.value[i] } }
const val = (e: Event) => (e.target as HTMLInputElement).value
</script>

<template>
  <div id="people-box" class="people-list">
    <table role="presentation" class="people-table">
      <tbody>
        <tr v-if="!people.length" class="person-card">
          <td colspan="3" class="sch-need-preview people-empty">还没有人员：请先在「数据导入」导入一份往期班表，人员名单会自动提取</td>
        </tr>
        <tr v-for="(p, i) in people" :key="p.en + '#' + i" class="person-card" :style="p.active ? undefined : { opacity: '.45' }">
          <td class="person-id">
            <input type="checkbox" :checked="!!p.active" :aria-label="'参与排班：' + p.cn" @change="emit('active', i, ($event.target as HTMLInputElement).checked)" />
            <span class="person-name"><b>{{ p.cn }}</b><small>{{ p.en }}</small></span>
          </td>
          <td class="person-need">
            <input type="text" :value="p.need || ''" :aria-label="p.cn + ' 的排班需求'"
              placeholder="如：11月25日-27日年假，周末白班，其余夜班，尽量少上夜班"
              @input="emit('need', i, val($event))" />
            <div class="chip-row">
              <span v-for="(c, k) in shown(i)" :key="k" class="need-chip" :class="'chip-' + c.kind">{{ c.text }}</span>
              <button v-if="chips[i].length > 2" type="button" class="chip-more" @click="toggle(i)">{{ expanded[i] ? '收起' : '+' + (chips[i].length - 2) }}</button>
              <span v-if="!p.need" class="chip-hint">＋ 写需求</span>
            </div>
          </td>
          <td class="sch-need-preview person-preview" :title="previews[i]">{{ previews[i] }}</td>
        </tr>
        <tr class="sch-custom-row person-card">
          <td class="person-id">
            <span class="person-name"><b>全员规则</b><small>叠加在个人需求之上</small></span>
          </td>
          <td class="person-need">
            <input type="text" :value="customText" aria-label="自定义需求（对全员生效）"
              placeholder="如：12月31日不休；每天白班至少3人；张三：12月1日-2日年假"
              @input="emit('update:customText', val($event))" />
          </td>
          <td class="sch-need-preview person-preview" :title="customPreview">{{ customPreview }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
