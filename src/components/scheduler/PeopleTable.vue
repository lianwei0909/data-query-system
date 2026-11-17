<script setup lang="ts">
// 人员需求表：每人一句话需求 + 全局「自定义需求」，右侧实时显示识别结果
import { computed } from 'vue'
import SCH from '../../solver/engine.js'
import type { Person } from '../../solver/types'

const props = defineProps<{ people: Person[]; customText: string; dates: Date[] | null }>()
const emit = defineEmits<{
  (e: 'active', index: number, v: boolean): void
  (e: 'need', index: number, v: string): void
  (e: 'update:customText', v: string): void
}>()
const previews = computed(() => props.people.map(p => SCH.describeNeed(SCH.parseNeedText(p.need || '', props.dates)) || '—'))
const customPreview = computed(() => SCH.describeCustom(SCH.parseCustomNeed(props.customText || '', props.dates, props.people)) || '—')
const val = (e: Event) => (e.target as HTMLInputElement).value
</script>

<template>
  <div id="people-box" class="sch-people-wrap">
    <table class="sch-people">
      <thead>
        <tr><th>参与</th><th>姓名</th><th>需求（一句话写清楚就行）</th><th>识别结果</th></tr>
      </thead>
      <tbody>
        <tr v-if="!people.length">
          <td class="sch-need-preview" colspan="4" style="text-align:center;max-width:none;padding:18px">还没有人员：请先在「数据导入」导入一份往期班表，人员名单会自动从班表中提取</td>
        </tr>
        <tr v-for="(p, i) in people" :key="p.en + '#' + i" :style="p.active ? undefined : { opacity: '.45' }">
          <td><input type="checkbox" :checked="!!p.active" :aria-label="'参与排班：' + p.cn" @change="emit('active', i, ($event.target as HTMLInputElement).checked)" /></td>
          <td style="font-weight:600">{{ p.cn }}</td>
          <td>
            <input
              type="text" :value="p.need || ''" style="width:100%;min-width:320px" :aria-label="p.cn + ' 的排班需求'"
              placeholder="如：11月25日-27日年假，12月8、9号休，周四周五休，周末白班，其余夜班，尽量少上夜班"
              @input="emit('need', i, val($event))"
            />
          </td>
          <td class="sch-need-preview" :title="previews[i]">{{ previews[i] }}</td>
        </tr>
        <tr class="sch-custom-row">
          <td title="自定义需求：对全员生效，也可点名某人">＋</td>
          <td style="font-weight:600">自定义需求</td>
          <td>
            <input
              type="text" :value="customText" style="width:100%;min-width:320px" aria-label="自定义需求（对全员生效）"
              placeholder="如：12月31日不休；每天白班至少3人；张三：12月1日-2日年假；周末上班最多4人"
              @input="emit('update:customText', val($event))"
            />
          </td>
          <td class="sch-need-preview" :title="customPreview">{{ customPreview }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
