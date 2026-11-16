// hash 路由：GitHub Pages 静态托管不需要 404 回退；每个页面单独分包（按需下载）
import { createRouter, createWebHashHistory } from 'vue-router'

export const PAGES = [
  { path: '/', name: 'calendar', title: '排班日历', group: '工作台', icon: 'calendar', load: () => import('../views/CalendarView.vue') },
  { path: '/import', name: 'import', title: '数据导入', group: '排班考勤', icon: 'import', load: () => import('../views/ImportView.vue') },
  { path: '/scheduler', name: 'scheduler', title: '智能排班', group: '排班考勤', icon: 'scheduler', load: () => import('../views/SchedulerView.vue') },
  { path: '/convert/approve', name: 'approve', title: '过审模块', group: '审核数据工具', icon: 'approve', load: () => import('../views/ConverterView.vue') },
  { path: '/convert/reject', name: 'reject', title: '不过审模块', group: '审核数据工具', icon: 'reject', load: () => import('../views/ConverterView.vue') }
] as const

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    ...PAGES.map(p => ({ path: p.path, name: p.name, component: p.load, meta: { title: p.title, group: p.group } })),
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach(to => {
  const t = (to.meta.title as string) || '排班考勤'
  document.title = `${t} · Data Query System`
})
export default router
