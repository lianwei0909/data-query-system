<script setup lang="ts">
// 应用外壳：侧栏导航 + 面包屑 + 主题开关 + 全局提示/加载层
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { PAGES } from './router'
import { theme, toggleTheme } from './composables/useTheme'
import { ui } from './core/notify'

const route = useRoute()
const groups = computed(() => {
  const m = new Map<string, typeof PAGES[number][]>()
  for (const p of PAGES) {
    if (!m.has(p.group)) m.set(p.group, [])
    m.get(p.group)!.push(p)
  }
  return [...m.entries()]
})
const current = computed(() => PAGES.find(p => p.name === route.name))
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-logo">
      <div class="logo-icon">📅</div>
      <div class="logo-text">
        <div class="logo-title">Data Query System</div>
        <div class="logo-sub">Attendance Manager</div>
      </div>
    </div>
    <template v-for="[group, items] in groups" :key="group">
      <div class="sidebar-section">
        <div class="sidebar-section-label">{{ group }}</div>
        <RouterLink v-for="p in items" :key="p.name" :to="p.path" class="nav-item" :class="{ active: current?.name === p.name }"
          :title="p.title" active-class="active">
          <div class="nav-icon" :class="p.icon === 'calendar' ? 'blue' : p.icon === 'import' ? 'gold' : p.icon === 'scheduler' ? 'orange' : p.icon === 'approve' ? 'green' : 'red'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="p.icon === 'calendar' ? 'var(--accent)' : 'currentColor'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <template v-if="p.icon === 'calendar' || p.icon === 'scheduler'">
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </template>
              <template v-else-if="p.icon === 'approve'"><polyline points="20 6 9 17 4 12" /></template>
              <template v-else-if="p.icon === 'reject'"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></template>
              <template v-else><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></template>
            </svg>
          </div>
          <span class="nav-label">{{ p.title }}</span>
        </RouterLink>
      </div>
    </template>
    <div class="sidebar-bottom">
      <button type="button" class="theme-switch" :class="{ 'is-on': theme === 'paper' }" :aria-pressed="theme === 'paper'"
        :title="theme === 'paper' ? '切换为暗色' : '切换为亮色'" @click="toggleTheme">
        <span class="ts-icon">
          <svg v-if="theme !== 'paper'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" /></svg>
        </span>
        <span class="ts-text">{{ theme === 'paper' ? '亮色模式' : '暗色模式' }}</span>
        <span class="ts-track"><span class="ts-thumb" /></span>
      </button>
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <div class="breadcrumb">
        <span class="breadcrumb-item">{{ current?.group }}</span>
        <span>›</span>
        <span class="breadcrumb-item current">{{ current?.title }}</span>
      </div>
      <slot name="topbar" />
    </header>
    <div class="page-content">
      <RouterView v-slot="{ Component }">
        <Suspense>
          <component :is="Component" />
          <template #fallback><div class="sub-loading">加载中…</div></template>
        </Suspense>
      </RouterView>
    </div>
  </div>

  <div id="dc-toast" :class="[ui.toast.type, { show: ui.toast.show }]" role="status" aria-live="polite">{{ ui.toast.msg }}</div>
  <div id="dc-loader" :class="{ active: ui.loader.show }">
    <div class="dc-spinner" /><div class="dc-loader-text">{{ ui.loader.text }}</div>
  </div>
</template>
