<script setup lang="ts">
// 便签画板（文字 + 画笔 + 粘贴图片）：v1 的 notesBoard.js 改写为 Vue 组件
// - 手写与图片存 IndexedDB（Blob），突破 localStorage 5MB 上限；首次打开自动迁移 v1 数据
// - 画布 / 图片拖拽统一用 Pointer Events + pointer capture：鼠标、触屏、手写笔同一套逻辑，不再挂 window 级监听
// - 画布尺寸由 ResizeObserver 驱动：切月份、折叠、放大、窗口缩放都自动适配，父组件无需再手动 resize
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { toast } from '../core/notify'
import { notifyStorageFull, readLS, writeLS } from '../core/storage'
import { isQuotaError } from '../core/idb'
import {
  LS_COLLAPSED, LS_MEMO, LS_MEMO_COLOR, boardPreview, clampImage, fitRect, newId, openBoardStore,
  type BoardImageLayout, type BoardStore
} from '../core/boardStore'

const props = defineProps<{
  /** 放大时对齐的目标元素（日历卡片） */
  anchor?: HTMLElement | null
}>()

type Mode = 'draw' | 'text'
interface ViewImage extends BoardImageLayout { url: string }

const mode = ref<Mode>('text')
const collapsed = ref(readLS(LS_COLLAPSED) === '1')
const maxed = ref(false)
const maxRect = ref<{ top: number; left: number; width: number; height: number } | null>(null)
const color = ref('#4f8ef7')
const size = ref(3)
const eraser = ref(false)
const memo = ref(readLS(LS_MEMO) || '')
const memoColor = ref(readLS(LS_MEMO_COLOR) || '')
const hasInk = ref(false)
const images = ref<ViewImage[]>([])
const stage = reactive({ w: 0, h: 0 })
const cursor = reactive({ show: false, x: 0, y: 0 })

const panelEl = ref<HTMLElement | null>(null)
const stageEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

let store: BoardStore | null = null
let disposed = false
let inkRestored = false          // 已保存的手写还没画回画布前，不能用空画布覆盖存档
let pendingInk: Blob | null = null
let saveAfterRestore = false
let pendingSave: Promise<unknown> = Promise.resolve()

const eraserSize = computed(() => Math.max(size.value, 22))
const preview = computed(() => boardPreview(memo.value, hasInk.value, images.value.length))
const toggleLabel = computed(() => collapsed.value ? '展开' : (maxed.value ? '还原' : '放大'))
const toggleTitle = computed(() => collapsed.value ? '展开便签' : (maxed.value ? '还原到右栏小便签' : '放大到日历大小，方便画图'))
const showHint = computed(() => mode.value === 'draw' && !hasInk.value)
const panelStyle = computed(() => maxed.value && maxRect.value
  ? { top: maxRect.value.top + 'px', left: maxRect.value.left + 'px', width: maxRect.value.width + 'px', height: maxRect.value.height + 'px' }
  : undefined)

function onSaveError(what: string, e: unknown) {
  console.warn(what + '保存失败：', e)
  if (isQuotaError(e)) notifyStorageFull(what, toast)
  else toast('⚠ ' + what + '保存失败：' + ((e as Error)?.message || e), 'error')
}

// ── 文字便签 ──
watch(memo, v => { if (!writeLS(LS_MEMO, v)) notifyStorageFull('便签文字', toast) })
function onMemoColor(e: Event) {
  memoColor.value = (e.target as HTMLInputElement).value
  writeLS(LS_MEMO_COLOR, memoColor.value)
}

// ── 折叠 / 放大 ──
watch(collapsed, v => {
  writeLS(LS_COLLAPSED, v ? '1' : '0')
  if (v) maxed.value = false
})
watch(maxed, v => { if (v) placeMax(); else maxRect.value = null })
function headAction() {
  if (maxed.value) maxed.value = false             // 放大态点标题栏 → 回到小便签
  else collapsed.value = !collapsed.value
}
function toggleAction() {
  if (collapsed.value) collapsed.value = false
  else maxed.value = !maxed.value
}
function placeMax() {
  if (!maxed.value || !props.anchor) return
  const r = props.anchor.getBoundingClientRect()
  if (r.width && r.height) maxRect.value = { top: r.top, left: r.left, width: r.width, height: r.height }
}

// ── 画布 ──
function ctx2d(): CanvasRenderingContext2D | null {
  return canvasEl.value ? canvasEl.value.getContext('2d') : null
}
/** 按 stage 尺寸重设画布（含 DPR），已有内容按比例居中缩放回去 */
function fitCanvas(w: number, h: number) {
  const cv = canvasEl.value, ctx = ctx2d()
  if (!cv || !ctx || !w || !h) return
  const dpr = window.devicePixelRatio || 1
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr)
  if (cv.width === pw && cv.height === ph) return
  let snap: HTMLCanvasElement | null = null
  if (cv.width && cv.height && hasInk.value && inkRestored) {
    snap = document.createElement('canvas')
    snap.width = cv.width; snap.height = cv.height
    snap.getContext('2d')!.drawImage(cv, 0, 0)
  }
  const prevW = cv.width / dpr, prevH = cv.height / dpr
  cv.width = pw; cv.height = ph
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (snap) {
    const r = fitRect(prevW, prevH, w, h)
    ctx.drawImage(snap, r.x, r.y, r.w, r.h)
  }
}
async function decode(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob) } catch { /* 走 Image 兜底 */ }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('图片解码失败')); img.src = url })
    return img
  } finally { URL.revokeObjectURL(url) }
}
/** 第一次有尺寸时把存档的手写画回去：按比例缩放、居中，不拉伸 */
async function restoreInk() {
  if (inkRestored || !store) return
  if (!pendingInk) { inkRestored = true; return }
  if (!stage.w || !stage.h) return                 // 还不可见（折叠中），下次有尺寸再还原
  const blob = pendingInk
  pendingInk = null
  try {
    const img = await decode(blob)
    const ctx = ctx2d()
    if (ctx && !disposed) {
      const r = fitRect(img.width, img.height, stage.w, stage.h)
      ctx.globalCompositeOperation = 'destination-over'   // 还原期间若已开始画，新笔迹保持在上层
      ctx.drawImage(img, r.x, r.y, r.w, r.h)
      ctx.globalCompositeOperation = 'source-over'
      hasInk.value = true
    }
  } catch (e) {
    console.warn('手写内容还原失败：', e)
  }
  inkRestored = true
  if (saveAfterRestore) { saveAfterRestore = false; saveInk() }
}
function saveInk() {
  if (!inkRestored) { saveAfterRestore = true; return }
  const cv = canvasEl.value
  if (!cv || !store) return
  const s = store
  pendingSave = new Promise<void>(resolve => {
    cv.toBlob(blob => {
      if (!blob) { resolve(); return }
      s.saveInk(blob).catch(e => onSaveError('手写内容', e)).finally(resolve)
    }, 'image/png')
  })
}
function clearInk() {
  const cv = canvasEl.value, ctx = ctx2d()
  if (cv && ctx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.restore() }
  hasInk.value = false
  pendingInk = null
  inkRestored = true
  store?.clearInk().catch(e => onSaveError('手写内容', e))
}

let drawing = false, lastX = 0, lastY = 0
function pos(e: PointerEvent) {
  const r = canvasEl.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function moveCursor(e: PointerEvent) {
  if (!eraser.value || !stageEl.value) return
  const r = stageEl.value.getBoundingClientRect()
  cursor.x = e.clientX - r.left; cursor.y = e.clientY - r.top; cursor.show = true
}
function onDown(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  const ctx = ctx2d()
  if (!ctx) return
  canvasEl.value!.setPointerCapture?.(e.pointerId)
  e.preventDefault()
  drawing = true
  const p = pos(e)
  lastX = p.x; lastY = p.y
  ctx.globalCompositeOperation = eraser.value ? 'destination-out' : 'source-over'
  ctx.beginPath()
  ctx.fillStyle = color.value
  ctx.arc(p.x, p.y, (eraser.value ? eraserSize.value : size.value) / 2, 0, Math.PI * 2)
  ctx.fill()
  hasInk.value = true
}
function onMove(e: PointerEvent) {
  moveCursor(e)
  if (!drawing) return
  const ctx = ctx2d()
  if (!ctx) return
  const p = pos(e)
  ctx.globalCompositeOperation = eraser.value ? 'destination-out' : 'source-over'
  ctx.strokeStyle = color.value
  ctx.lineWidth = eraser.value ? eraserSize.value : size.value
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke()
  lastX = p.x; lastY = p.y
}
function onUp(e: PointerEvent) {
  if (!drawing) return
  drawing = false
  canvasEl.value?.releasePointerCapture?.(e.pointerId)
  ctx2d()!.globalCompositeOperation = 'source-over'
  saveInk()
}
function onColor(e: Event) { color.value = (e.target as HTMLInputElement).value; eraser.value = false }

// ── 粘贴图片：拖动 / 缩放 / 删除 ──
const layoutOf = (list: ViewImage[]): BoardImageLayout[] => list.map(({ id, x, y, w }) => ({ id, x, y, w }))
function imgStyle(it: ViewImage) {
  const c = clampImage(it, stage.w, stage.h)
  return { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px' }
}
let drag: { it: ViewImage; kind: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number; ow: number } | null = null
function startDrag(e: PointerEvent, it: ViewImage, kind: 'move' | 'resize') {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  const c = clampImage(it, stage.w, stage.h)
  drag = { it, kind, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, ow: c.w }
}
function onDrag(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy
  if (drag.kind === 'move') { drag.it.x = drag.ox + dx; drag.it.y = drag.oy + dy }
  else drag.it.w = Math.max(40, drag.ow + dx)
}
function endDrag() {
  if (!drag) return
  const c = clampImage(drag.it, stage.w, stage.h)          // 落点收进画布内再保存
  Object.assign(drag.it, c)
  drag = null
  store?.saveLayout(layoutOf(images.value)).catch(e => onSaveError('图片位置', e))
}
function removeImage(it: ViewImage) {
  images.value = images.value.filter(x => x !== it)
  URL.revokeObjectURL(it.url)
  store?.removeImage(it.id, layoutOf(images.value)).catch(e => onSaveError('图片', e))
}
async function addImage(blob: Blob) {
  if (collapsed.value) collapsed.value = false
  await nextTick()
  const sw = stage.w || 400, sh = stage.h || 400
  const w = Math.min(200, sw * 0.55)
  const it: ViewImage = { id: newId(), x: (sw - w) / 2, y: sh * 0.08, w, url: URL.createObjectURL(blob) }
  images.value = [...images.value, it]
  if (!store) return
  try { await store.addImage({ id: it.id, x: it.x, y: it.y, w: it.w, blob }, layoutOf(images.value)) }
  catch (e) { onSaveError('粘贴的图片', e) }
}
function onPaste(e: ClipboardEvent) {
  if (!panelEl.value || panelEl.value.offsetParent === null) return   // 便签不可见（不在日历页）时不拦截
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of Array.from(items)) {
    if (item.type && item.type.startsWith('image')) {
      const blob = item.getAsFile()
      if (!blob) return
      e.preventDefault()
      addImage(blob)
      return
    }
  }
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && maxed.value) maxed.value = false }

// ── 生命周期 ──
let stageRO: ResizeObserver | null = null
let anchorRO: ResizeObserver | null = null
const onWin = () => placeMax()

onMounted(async () => {
  stageRO = new ResizeObserver(entries => {
    const r = entries[0].contentRect
    if (!r.width || !r.height) return                // 折叠时 0 尺寸：保留画布内容不动
    stage.w = r.width; stage.h = r.height
    fitCanvas(r.width, r.height)
    restoreInk()
    if (maxed.value) placeMax()
  })
  if (stageEl.value) stageRO.observe(stageEl.value)
  document.addEventListener('paste', onPaste)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onWin)
  window.addEventListener('scroll', onWin, true)     // 捕获阶段：页面内任意滚动容器滚动都能跟随

  const s = await openBoardStore()
  if (disposed) { s.close(); return }
  store = s
  try {
    const [imgs, ink] = await Promise.all([s.loadImages(), s.loadInk()])
    if (disposed) return
    images.value = [...imgs.map(i => ({ id: i.id, x: i.x, y: i.y, w: i.w, url: URL.createObjectURL(i.blob) })), ...images.value]
    pendingInk = ink
    if (ink) hasInk.value = true
  } catch (e) {
    console.warn('便签数据读取失败：', e)
  }
  restoreInk()
})
watch(() => props.anchor, (el, old) => {
  if (!anchorRO) anchorRO = new ResizeObserver(() => placeMax())
  if (old) anchorRO.unobserve(old)
  if (el) anchorRO.observe(el)
}, { immediate: true })

onBeforeUnmount(() => {
  disposed = true
  stageRO?.disconnect(); anchorRO?.disconnect()
  document.removeEventListener('paste', onPaste)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onWin)
  window.removeEventListener('scroll', onWin, true)
  images.value.forEach(i => URL.revokeObjectURL(i.url))
  const s = store
  store = null
  pendingSave.finally(() => s?.close())              // 等最后一笔写完再关库
})

defineExpose({ /** 供测试与调试：当前存储类型 */ storageKind: () => store?.kind ?? null })
</script>

<template>
  <div
    ref="panelEl"
    id="blank-canvas"
    class="canvas-panel board-panel"
    :class="{ text: mode === 'text', collapsed, 'is-max': maxed }"
    :style="panelStyle"
  >
    <div
      class="board-head" id="board-head" role="button" tabindex="0"
      :aria-expanded="collapsed ? 'false' : 'true'" title="点击收起 / 展开便签"
      @click="headAction" @keydown.enter.prevent="headAction" @keydown.space.prevent="headAction"
    >
      <span class="board-head-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></span>
      <span class="board-head-title">便签</span>
      <span class="board-head-preview" id="board-preview">{{ preview }}</span>
      <button class="board-head-toggle" id="board-max-btn" type="button" :title="toggleTitle" :aria-label="toggleLabel" @click.stop="toggleAction">
        <span id="board-toggle">{{ toggleLabel }}</span>
        <svg class="ic-expand" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
        <svg class="ic-restore" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
      </button>
    </div>

    <div class="board-toolbar">
      <div class="board-modes" role="group" aria-label="便签模式">
        <button class="board-mode-btn" :class="{ active: mode === 'draw' }" :aria-pressed="mode === 'draw'" data-mode="draw" type="button" @click="mode = 'draw'">✏️ 画笔</button>
        <button class="board-mode-btn" :class="{ active: mode === 'text' }" :aria-pressed="mode === 'text'" data-mode="text" type="button" @click="mode = 'text'">📝 文字</button>
      </div>
      <div class="board-tools" id="board-tools">
        <div v-if="mode === 'draw'" class="draw-tools" id="draw-tools" style="display:flex">
          <button class="board-eraser" :class="{ active: eraser }" :aria-pressed="eraser" id="board-eraser" type="button" title="橡皮擦" @click="eraser = !eraser">🧽 橡皮擦</button>
          <label class="board-color-picker" title="调色盘">
            <input type="color" id="board-color" :value="color" aria-label="画笔颜色" @input="onColor" />
            <span class="board-color-swatch" id="board-color-swatch" :style="{ background: color }"></span>
            <span class="board-color-label">调色盘</span>
          </label>
          <div class="board-size">
            粗细
            <input v-model.number="size" type="range" id="board-size" min="1" max="24" aria-label="画笔粗细" />
          </div>
          <button class="board-clear" id="board-clear" type="button" @click="clearInk">🗑 清空</button>
        </div>
        <div v-else class="text-tools" id="text-tools" style="display:flex">
          <label class="board-color-picker" title="文字颜色">
            <input type="color" id="board-text-color" :value="memoColor || '#e8eaf0'" aria-label="文字颜色" @input="onMemoColor" />
            <span class="board-color-swatch" id="board-text-color-swatch" :style="{ background: memoColor || 'var(--text-primary)' }"></span>
            <span class="board-color-label">文字颜色</span>
          </label>
        </div>
      </div>
    </div>

    <div ref="stageEl" class="board-stage" id="board-stage">
      <canvas
        ref="canvasEl" id="board-canvas"
        :style="{ cursor: eraser ? 'none' : 'crosshair' }"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
        @pointerleave="cursor.show = false" @pointerenter="cursor.show = eraser"
      ></canvas>
      <div
        v-show="eraser && cursor.show && mode === 'draw'" class="board-cursor" id="board-cursor"
        :style="{ display: 'block', left: cursor.x + 'px', top: cursor.y + 'px', width: eraserSize + 'px', height: eraserSize + 'px' }"
      ></div>
      <textarea
        id="board-memo" v-model="memo" :style="{ color: memoColor || '' }"
        placeholder="在这里写备忘笔记…（内容会自动保存）" spellcheck="false" aria-label="便签文字"
      ></textarea>
      <div v-show="showHint" class="board-hint" id="board-hint">用画笔在上面自由书写 / 绘图 · Ctrl+V 粘贴图片</div>
      <div
        v-for="it in images" :key="it.id" class="board-img" :style="imgStyle(it)"
        @pointerdown="startDrag($event, it, 'move')" @pointermove="onDrag" @pointerup="endDrag" @pointercancel="endDrag"
      >
        <img :src="it.url" alt="粘贴的图片" draggable="false" />
        <button class="board-img-del" type="button" aria-label="删除图片" @pointerdown.stop @click.stop="removeImage(it)">×</button>
        <span
          class="board-img-resize" aria-hidden="true"
          @pointerdown="startDrag($event, it, 'resize')" @pointermove="onDrag" @pointerup="endDrag" @pointercancel="endDrag"
        ></span>
      </div>
    </div>
  </div>
</template>
