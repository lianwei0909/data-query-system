<script setup lang="ts">
// 求解中：阶段卡片（对应 useSolver 的 build / solve / stage1 / stage2 / fallback）
import { computed } from 'vue'

const props = defineProps<{ pct: number; stage: string | null; text: string; elapsed: number }>()
const emit = defineEmits<{ (e: 'cancel'): void }>()
const STAGES = [
  { key: 'build', label: '建模' },
  { key: 'solve', label: '精确求解' },
  { key: 'stage1', label: '夜班均衡' },
  { key: 'stage2', label: '校验' }
]
const activeIdx = computed(() => {
  const s = props.stage
  if (s === 'stage1' || s === 'stage2') return 2
  if (s === 'solve' || s === 'fallback') return 1
  return 0
})
</script>

<template>
  <div class="solve-progress" role="status" aria-live="polite">
    <div class="solve-head">
      <span class="solve-spinner" aria-hidden="true"></span>
      <span class="solve-text"><b>正在排班…</b><small>{{ text || '正在准备模型' }}　已用时 {{ elapsed }} 秒</small></span>
      <button type="button" class="solve-cancel" @click="emit('cancel')">取消</button>
    </div>
    <div class="solve-track"><div class="solve-fill" :style="{ width: pct + '%' }"></div></div>
    <div class="solve-stages">
      <span v-for="(s, i) in STAGES" :key="s.key" :class="{ done: i < activeIdx, active: i === activeIdx }">{{ i + 1 }}. {{ s.label }}</span>
    </div>
  </div>
</template>
