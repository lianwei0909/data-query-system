
<script setup lang="ts">
// 侧栏 / 顶栏共用的页面图标；描边色为 currentColor，由外层 .nav-icon.<色调> 决定
withDefaults(defineProps<{ icon?: string; size?: number }>(), { icon: 'calendar', size: 16 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <!-- 排班日历：月历 + 两个日期点 -->
    <template v-if="icon === 'calendar'">
      <rect x="3" y="4" width="18" height="18" rx="2.5" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="14.5" x2="8.01" y2="14.5" /><line x1="12" y1="14.5" x2="12.01" y2="14.5" /><line x1="16" y1="14.5" x2="16.01" y2="14.5" />
    </template>
    <!-- 智能排班：闪电（与“⚡ 生成排班”主按钮呼应） -->
    <template v-else-if="icon === 'scheduler'"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></template>
    <template v-else-if="icon === 'approve'"><polyline points="20 6 9 17 4 12" /></template>
    <template v-else-if="icon === 'reject'"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></template>
    <!-- 数据导入：上传云 -->
    <template v-else><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></template>
  </svg>
</template>
