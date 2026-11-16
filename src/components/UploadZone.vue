<script setup lang="ts">
// 拖拽 / 点选上传（CSV / Excel）：统一格式校验与提示，供导入页和转换页复用
import { ref } from 'vue'
import { ACCEPT, isSupported } from '../core/readFile'
import { toast } from '../core/notify'

const props = withDefaults(defineProps<{ accept?: string; title?: string; hint?: string; maxSizeMb?: number }>(), {
  accept: ACCEPT, title: '把文件拖到这里，或点击选择', hint: '支持 .csv / .txt / .xlsx / .xls', maxSizeMb: 10
})
const emit = defineEmits<{ file: [File] }>()
const over = ref(false)
const input = ref<HTMLInputElement | null>(null)

function pick(f: File | undefined | null) {
  if (!f) return
  if (!isSupported(f.name)) { toast('请上传 CSV 或 Excel 文件', 'error'); return }
  if (f.size > props.maxSizeMb * 1024 * 1024) { toast(`文件过大（最大 ${props.maxSizeMb}MB）`, 'error'); return }
  emit('file', f)
}
function onDrop(e: DragEvent) {
  e.preventDefault(); over.value = false
  pick(e.dataTransfer?.files?.[0])
}
</script>

<template>
  <div class="upload-zone" :class="{ 'drag-over': over }" role="button" tabindex="0"
    @click="input?.click()" @keydown.enter.prevent="input?.click()" @keydown.space.prevent="input?.click()"
    @dragover.prevent="over = true" @dragleave="over = false" @drop="onDrop">
    <div class="upload-arrow-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".55">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    </div>
    <div class="file-input-wrapper">
      <label class="file-label" @click.stop><span>📂</span> <span>选择文件</span>
        <input ref="input" type="file" class="file-input" :accept="accept" @change="pick(($event.target as HTMLInputElement).files?.[0])" />
      </label>
    </div>
    <div class="upload-text">{{ title }}</div>
    <div class="format-hint">{{ hint }}</div>
  </div>
</template>
