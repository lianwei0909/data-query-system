<script setup lang="ts">
// 排班日历：统计卡 / 日历 / 当日出勤 / 本月概览全部由 core 纯函数计算，口径与单测一致
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { shiftState } from '../core/shiftStore'
import { computeDayAttendance, computeOverview, computeStats } from '../core/stats'
import { classifyShift, findUserRow, getDateShift, listPeople, matchPerson, personLabel } from '../core/shift'
import { readLS, writeLS, removeLS } from '../core/storage'
import { mountBoard, unmountBoard, resizeBoard } from '../legacy/notesBoard'

const router = useRouter()
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const AVATAR = ['blue', 'green', 'purple', 'orange', 'pink', 'cyan', 'gold', 'rose', 'teal', 'indigo']
const WHO_KEY = 'viewer_name'

const now = new Date()
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
const cal = ref({ y: today.getFullYear(), m: today.getMonth() })            // m: 0-11
const sel = ref({ y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() })

const data = computed(() => { void shiftState.version; return shiftState.rows })

// ── 查看人 ──
const viewer = ref(readLS(WHO_KEY) || '')
const whoInput = ref(viewer.value)
const whoStatus = ref<{ text: string; cls: string }>({ text: '', cls: '' })
const people = computed(() => listPeople(data.value))
const viewerPerson = computed(() => people.value.find(p => p.en.toLowerCase() === viewer.value.toLowerCase()) || null)
let statusTimer: ReturnType<typeof setTimeout> | null = null
function setStatus(text: string, cls = '') {
  whoStatus.value = { text, cls }
  if (statusTimer) clearTimeout(statusTimer)
  if (cls === 'ok') statusTimer = setTimeout(() => { whoStatus.value = { text: '', cls: '' } }, 3000)
}
function setViewer(q: string, fill = true) {
  q = q.trim()
  if (!q) { viewer.value = ''; removeLS(WHO_KEY); setStatus(''); return }
  if (!data.value.length) { setStatus('还没有班表数据，请先在「数据导入」导入班表', 'warn'); return }
  const m = matchPerson(people.value, q)
  if (m.person) {
    viewer.value = m.person.en; writeLS(WHO_KEY, m.person.en)
    if (fill) whoInput.value = m.person.en
    setStatus('✓ 已识别：' + personLabel(m.person), 'ok')
  } else if (m.candidates.length > 1) {
    setStatus('匹配到多人：' + m.candidates.slice(0, 5).map(x => x.en).join('、') + '，请写全一点', 'warn')
  } else {
    setStatus(`班表里找不到「${q}」` + (people.value.length ? '，可选：' + people.value.slice(0, 8).map(x => x.en).join('、') : ''), 'err')
  }
}
function onWhoInput() {
  const m = matchPerson(people.value, whoInput.value)
  if (m.person && m.how === 'exact') setViewer(whoInput.value, false)
}

// ── 统计 / 明细 / 概览 ──
const stats = computed(() => computeStats(data.value, viewer.value, today))
const attendance = computed(() => computeDayAttendance(data.value, viewer.value, sel.value.y, sel.value.m, sel.value.d))
const userRow = computed(() => (viewer.value ? findUserRow(data.value, viewer.value) : null))
const overview = computed(() => (userRow.value ? computeOverview(userRow.value, today) : null))
const ovRows = computed(() => {
  const o = overview.value
  if (!o) return []
  const total = Math.max(1, o.day + o.night + o.rest + o.leave)
  return ([['白班', o.day, 'day'], ['夜班', o.night, 'night'], ['休息', o.rest, 'rest'], ['请假', o.leave, 'leave']] as const)
    .map(([label, n, k]) => ({ label, n, k, pct: Math.round((n / total) * 100) }))
})

// ── 日历网格 ──
interface Cell { d: number; other: boolean; wd: number; today: boolean; shift?: { k: string; t: string; raw: string } | null; none?: boolean }
const cells = computed<Cell[]>(() => {
  const { y, m } = cal.value
  const first = new Date(y, m, 1).getDay()
  const dim = new Date(y, m + 1, 0).getDate()
  const dimPrev = new Date(y, m, 0).getDate()
  const todayKey = today.getTime()
  const out: Cell[] = []
  for (let i = first - 1; i >= 0; i--) out.push({ d: dimPrev - i, other: true, wd: new Date(y, m - 1, dimPrev - i).getDay(), today: false })
  for (let d = 1; d <= dim; d++) {
    const date = new Date(y, m, d)
    const raw = userRow.value ? getDateShift(userRow.value, y, m + 1, d) : ''
    const c = raw ? classifyShift(raw) : null
    out.push({
      d, other: false, wd: date.getDay(), today: date.getTime() === todayKey,
      shift: c ? { ...c, raw } : null,
      none: !!userRow.value && !raw && date.getTime() >= todayKey
    })
  }
  const total = first + dim
  const remain = total <= 35 ? 35 - total : 42 - total
  for (let n = 1; n <= remain; n++) out.push({ d: n, other: true, wd: new Date(y, m + 1, n).getDay(), today: false })
  return out
})
const calHint = computed<{ text: string; to: string } | null>(() => {
  if (!data.value.length) return { text: '还没有班表 · 去数据导入 ›', to: '/import' }
  if (!userRow.value) return null
  const first = cells.value.find(c => !c.other && c.none)
  if (!first) return null
  return { text: first.d === 1 ? '本月还没有班表 · 去智能排班 ›' : `${cal.value.m + 1}/${first.d} 起还没有班表 · 去智能排班 ›`, to: '/scheduler' }
})
function changeMonth(delta: number) {
  let { y, m } = cal.value
  m += delta
  if (m > 11) { m = 0; y++ }
  if (m < 0) { m = 11; y-- }
  cal.value = { y, m }
  const d = sel.value.y === y && sel.value.m === m + 1 ? sel.value.d
    : y === today.getFullYear() && m === today.getMonth() ? today.getDate() : 1
  sel.value = { y, m: m + 1, d }
}
function pick(c: Cell) { if (!c.other) sel.value = { y: cal.value.y, m: cal.value.m + 1, d: c.d } }
const isSel = (c: Cell) => !c.other && sel.value.y === cal.value.y && sel.value.m === cal.value.m + 1 && sel.value.d === c.d
const avatarColor = (name: string) => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h) + name.charCodeAt(i)
  return AVATAR[Math.abs(h) % AVATAR.length]
}
const selWeek = computed(() => WEEK[new Date(sel.value.y, sel.value.m - 1, sel.value.d).getDay()])

onMounted(async () => {
  if (viewer.value && data.value.length) setViewer(viewer.value)
  await nextTick()
  mountBoard()
  resizeBoard()
})
onBeforeUnmount(() => { unmountBoard(); if (statusTimer) clearTimeout(statusTimer) })
watch(() => [cal.value.y, cal.value.m], () => nextTick(() => resizeBoard()))
</script>

<template>
  <div id="page-calendar">
    <!-- 查看人 -->
    <div class="topbar-who who-box calendar-who">
      <span class="who-status" :class="whoStatus.cls">{{ whoStatus.text }}</span>
      <span class="who-label">查看</span>
      <div class="who-avatar" :class="{ miss: !viewerPerson }">{{ viewerPerson ? (viewerPerson.cn || viewerPerson.en).charAt(0).toUpperCase() : '?' }}</div>
      <input v-model="whoInput" type="text" class="who-input" list="who-options" placeholder="英文名 / 中文名" autocomplete="off" spellcheck="false"
        aria-label="查看谁的班表" @input="onWhoInput" @change="setViewer(whoInput)" @keydown.enter.prevent="setViewer(whoInput)"
        @keydown.esc="whoInput = ''; setViewer('')" />
      <button type="button" class="who-clear" title="清空" aria-label="清空查看人" @click="whoInput = ''; setViewer('')">×</button>
      <datalist id="who-options"><option v-for="p in people" :key="p.en" :value="p.en" /></datalist>
    </div>

    <!-- 统计卡 -->
    <div class="stats-row">
      <div v-for="(s, i) in stats" :key="i" class="stat-card">
        <div class="stat-icon" :class="['blue', 'green', 'orange', 'purple'][i]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" :stroke="['var(--accent)', 'var(--green)', 'var(--orange)', 'var(--purple)'][i]" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <template v-if="i === 0"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><polyline points="9 15 11 17 15 13" /></template>
            <template v-else-if="i === 1"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></template>
            <template v-else-if="i === 2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></template>
            <template v-else><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></template>
          </svg>
        </div>
        <div class="stat-info">
          <div class="stat-combo">
            <template v-if="s.kind === 'num'">
              <div class="stat-value"><span class="num">{{ s.value }}</span><span class="unit">{{ s.unit }}</span></div>
              <div class="stat-label" :title="s.tip">{{ s.label }}</div>
            </template>
            <template v-else-if="s.kind === 'special'">
              <div class="stat-value"><span class="num special">{{ s.text }}</span></div>
              <div class="stat-label">{{ s.label }}</div>
            </template>
            <template v-else>
              <div class="stat-value"><span class="num">--</span></div>
              <div class="stat-label">{{ s.label }}<span class="stat-hint">{{ s.hint }}</span></div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="content-grid">
      <!-- 日历 -->
      <div id="calendar" class="calendar-card">
        <div class="card-header">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap">
            <div class="card-title">{{ cal.y }}年 {{ cal.m + 1 }}月<span class="card-title-sub">排班总览</span></div>
            <span v-if="calHint" class="cal-hint" role="link" tabindex="0" title="点击前往"
              @click="router.push(calHint.to)" @keydown.enter="router.push(calHint.to)">{{ calHint.text }}</span>
          </div>
          <div class="cal-nav">
            <button type="button" class="cal-nav-btn" title="上个月" aria-label="上个月" @click="changeMonth(-1)">◀</button>
            <button type="button" class="cal-nav-btn" title="下个月" aria-label="下个月" @click="changeMonth(1)">▶</button>
          </div>
        </div>
        <div class="cal-legend">
          <div class="legend-item"><div class="legend-dot blue" />白班</div>
          <div class="legend-item"><div class="legend-dot orange" />夜班</div>
          <div class="legend-item"><div class="legend-dot red" />休息</div>
          <div class="legend-item"><div class="legend-dot purple" />请假</div>
        </div>
        <div class="cal-grid">
          <div v-for="(w, i) in WEEK" :key="'h' + i" class="cal-head" :class="{ weekend: i === 0 || i === 6 }">{{ w }}</div>
          <div v-for="(c, i) in cells" :key="i" class="cal-cell"
            :class="{ 'weekend-col': c.wd === 0 || c.wd === 6, 'other-month': c.other, empty: c.other, clickable: !c.other, today: c.today, selected: isSel(c) }"
            :data-s="c.shift?.k" :tabindex="c.other ? -1 : 0" :role="c.other ? undefined : 'button'"
            :aria-label="c.other ? undefined : `${cal.m + 1}月${c.d}日` + (c.shift ? ' ' + c.shift.raw : '')"
            :title="c.shift ? `${cal.m + 1}月${c.d}日：${c.shift.raw}` : undefined"
            @click="pick(c)" @keydown.enter.prevent="pick(c)" @keydown.space.prevent="pick(c)">
            <div class="cal-date">{{ c.d }}</div>
            <span v-if="!c.other && c.shift" class="cal-shift" :class="'s-' + c.shift.k" :title="c.shift.raw">{{ c.shift.t }}</span>
            <span v-else-if="!c.other && c.none" class="cal-shift s-none">未排</span>
          </div>
        </div>
      </div>

      <!-- 右侧栏 -->
      <div class="side-col">
        <div class="detail-card">
          <div class="card-header" style="margin-bottom:0">
            <div>
              <div class="card-title">{{ sel.m }}月{{ sel.d }}日 出勤</div>
              <div class="detail-date">{{ sel.y }}年{{ sel.m }}月{{ sel.d }}日 · 星期{{ selWeek }}</div>
            </div>
          </div>
          <div class="attendance-count">
            <div class="attendance-count-num">{{ data.length ? attendance.day.length + attendance.night.length : '--' }}</div>
            <div>
              <div class="attendance-count-label">出勤人员</div>
              <div class="attendance-mini-stats">
                <div class="mini-stat"><div class="mini-stat-dot blue" /><span>白班 {{ attendance.day.length }}人</span></div>
                <div class="mini-stat"><div class="mini-stat-dot night" /><span>夜班 {{ attendance.night.length }}人</span></div>
              </div>
            </div>
          </div>
          <div v-for="grp in ([['day', '白班', attendance.day], ['night', '夜班', attendance.night]] as const)" :key="grp[0]" class="shift-section">
            <div class="shift-section-header">
              <div class="shift-indicator" :class="grp[0]" />
              <div class="shift-section-title">{{ grp[1] }}</div>
              <span class="shift-count-badge" :class="grp[0]">{{ grp[2].length }}人</span>
            </div>
            <div class="staff-list">
              <div v-if="!grp[2].length" class="staff-empty">{{ data.length ? `当天没有${grp[1]}` : '还没有班表' }}</div>
              <div v-for="p in grp[2]" :key="p.name" class="staff-item" :class="{ me: p.me }">
                <div class="staff-avatar" :class="avatarColor(p.name)">{{ p.name.charAt(0) }}</div>
                <div style="flex:1;min-width:0">
                  <div class="staff-name">{{ p.name }}<span v-if="p.me" class="staff-me">当前查看</span></div>
                </div>
                <div class="staff-tags">
                  <span v-if="p.duty" class="staff-duty" :title="p.duty">{{ p.duty.includes(' / ') ? '双值班' : p.duty }}</span>
                  <span class="staff-shift-tag" :class="grp[0]">{{ p.shift }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="duty-miss">{{ attendance.dutyMiss.length ? '⚠ ' + attendance.dutyMiss.join('；') + '（当天不在岗）' : '' }}</div>
        </div>

        <!-- 便签画板（遗留模块，DOM id 与 v1 一致） -->
      <!-- 便签画板 -->
      <div class="canvas-panel board-panel text" id="blank-canvas">
      <div class="board-head" id="board-head" role="button" tabindex="0" aria-expanded="true" title="点击收起 / 展开便签">
      <span class="board-head-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span>
      <span class="board-head-title">便签</span>
      <span class="board-head-preview" id="board-preview"></span>
      <button class="board-head-toggle" id="board-max-btn" type="button" title="放大到日历大小，方便画图">
      <span id="board-toggle">放大</span>
      <svg class="ic-expand" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      <svg class="ic-restore" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
      </div>
      <div class="board-toolbar">
      <div class="board-modes">
      <button class="board-mode-btn" data-mode="draw" type="button">✏️ 画笔</button>
      <button class="board-mode-btn active" data-mode="text" type="button">📝 文字</button>
      </div>
      <div class="board-tools" id="board-tools">
      <div class="draw-tools" id="draw-tools" style="display:none">
      <button class="board-eraser" id="board-eraser" type="button" title="橡皮擦">🧽 橡皮擦</button>
      <label class="board-color-picker" title="调色盘">
      <input type="color" id="board-color" value="#4f8ef7" aria-label="画笔颜色" />
      <span class="board-color-swatch" id="board-color-swatch"></span>
      <span class="board-color-label">调色盘</span>
      </label>
      <div class="board-size">
      粗细
      <input type="range" id="board-size" min="1" max="24" value="3" aria-label="画笔粗细" />
      </div>
      <button class="board-clear" id="board-clear" type="button">🗑 清空</button>
      </div>
      <div class="text-tools" id="text-tools">
      <label class="board-color-picker" title="文字颜色">
      <input type="color" id="board-text-color" value="#e8eaf0" aria-label="文字颜色" />
      <span class="board-color-swatch" id="board-text-color-swatch"></span>
      <span class="board-color-label">文字颜色</span>
      </label>
      </div>
      </div>
      </div>
      <div class="board-stage" id="board-stage">
      <canvas id="board-canvas"></canvas>
      <div class="board-cursor" id="board-cursor"></div>
      <textarea id="board-memo" placeholder="在这里写备忘笔记…（内容会自动保存）" spellcheck="false"></textarea>
      <div class="board-hint" id="board-hint" style="display:none">用画笔在上面自由书写 / 绘图 · Ctrl+V 粘贴图片</div>

      </div>
      </div>

        <!-- 本月概览 -->
        <div class="overview-card">
          <div class="ov-head">
            <span class="ov-title">本月概览</span>
            <span class="ov-period">{{ overview ? `${overview.start.getMonth() + 1}/${overview.start.getDate()} - ${overview.end.getMonth() + 1}/${overview.end.getDate()}` : '' }}</span>
          </div>
          <div class="ov-list">
            <div v-if="!overview" class="staff-empty">{{ data.length ? '先在上方选择查看的人' : '导入班表后显示统计' }}</div>
            <div v-for="r in ovRows" :key="r.k" class="ov-row">
              <span class="ov-label">{{ r.label }}</span>
              <div class="ov-bar"><div class="ov-fill" :style="{ width: r.pct + '%', background: `var(--${r.k})` }" /></div>
              <span class="ov-val">{{ r.n }} 天</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calendar-who { margin: 0 0 14px auto; justify-content: flex-end; flex-wrap: wrap; }
</style>
