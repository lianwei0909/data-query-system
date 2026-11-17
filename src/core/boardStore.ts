// 便签画板持久化：手写画布与粘贴图片存 IndexedDB（以 Blob 存储，突破 localStorage 5MB 上限），
// 文字便签、颜色、折叠状态仍存 localStorage（体积小、需要同步读取）。
// 首次使用自动把 v1 存在 localStorage 的 board_images / board_canvas 迁到 IndexedDB，写入成功后才删除旧 key。
// IndexedDB 不可用时降级为 v1 的 localStorage 存法（dataURL），行为与 v1 一致。
import { openKV, type KV } from './idb'
import type { StorageLike } from './storage'

export interface BoardImageLayout { id: string; x: number; y: number; w: number }
export interface BoardImage extends BoardImageLayout { blob: Blob }

/** v1 在 localStorage 的存法 */
interface LegacyImage { src: string; x: number; y: number; w: number }

export const LS_MEMO = 'board_memo'
export const LS_MEMO_COLOR = 'board_memo_color'
export const LS_COLLAPSED = 'board_collapsed'
export const LS_LEGACY_IMAGES = 'board_images'
export const LS_LEGACY_CANVAS = 'board_canvas'
const K_LAYOUT = 'board_images_layout'
const K_CANVAS = 'board_canvas'
const K_IMG = (id: string) => 'board_img:' + id

export type { StorageLike }

export interface BoardStore {
  readonly kind: 'idb' | 'local'
  loadImages(): Promise<BoardImage[]>
  addImage(img: BoardImage, layout: BoardImageLayout[]): Promise<void>
  removeImage(id: string, layout: BoardImageLayout[]): Promise<void>
  saveLayout(layout: BoardImageLayout[]): Promise<void>
  loadInk(): Promise<Blob | null>
  saveInk(blob: Blob): Promise<void>
  clearInk(): Promise<void>
  close(): void
}

// ── Blob / dataURL 互转（浏览器与 Node 18+ 均可用，不依赖 FileReader） ──
export function dataURLToBlob(url: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (!m) throw new Error('不是有效的 dataURL')
  const type = m[1] || 'application/octet-stream'
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type })
  const bin = atob(m[3])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}
export async function blobToDataURL(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(bin)
}

export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function safeLS(): StorageLike | null {
  try { return (globalThis as { localStorage?: StorageLike }).localStorage ?? null } catch { return null }
}

/** v1 → v2 迁移：先写 IndexedDB，全部成功后再删 localStorage 旧 key；中途失败旧数据原样保留，下次再迁 */
export async function migrateLegacy(kv: KV, ls: StorageLike): Promise<{ images: number; canvas: boolean }> {
  let images = 0, canvas = false
  const rawImgs = ls.getItem(LS_LEGACY_IMAGES)
  if (rawImgs) {
    let legacy: LegacyImage[] = []
    try { legacy = JSON.parse(rawImgs) } catch { legacy = [] }
    const layout = ((await kv.get<BoardImageLayout[]>(K_LAYOUT)) || []).slice()
    for (const it of Array.isArray(legacy) ? legacy : []) {
      if (!it || typeof it.src !== 'string') continue
      let blob: Blob
      try { blob = dataURLToBlob(it.src) } catch { continue }
      const id = newId()
      await kv.set(K_IMG(id), blob)
      layout.push({ id, x: +it.x || 0, y: +it.y || 0, w: +it.w || 200 })
      images++
    }
    await kv.set(K_LAYOUT, layout)
    ls.removeItem(LS_LEGACY_IMAGES)
  }
  const rawInk = ls.getItem(LS_LEGACY_CANVAS)
  if (rawInk) {
    const existing = await kv.get<Blob>(K_CANVAS)
    if (!existing) {
      let blob: Blob | null = null
      try { blob = dataURLToBlob(rawInk) } catch { blob = null }   // 旧数据损坏：直接丢弃
      if (blob) { await kv.set(K_CANVAS, blob); canvas = true }    // 写入失败会抛出，旧 key 保留
    }
    ls.removeItem(LS_LEGACY_CANVAS)
  }
  return { images, canvas }
}

function idbStore(kv: KV): BoardStore {
  return {
    kind: 'idb',
    async loadImages() {
      const layout = (await kv.get<BoardImageLayout[]>(K_LAYOUT)) || []
      const out: BoardImage[] = []
      for (const l of layout) {
        const blob = await kv.get<Blob>(K_IMG(l.id))
        if (blob) out.push({ ...l, blob })
      }
      return out
    },
    async addImage(img, layout) { await kv.set(K_IMG(img.id), img.blob); await kv.set(K_LAYOUT, layout) },
    async removeImage(id, layout) { await kv.set(K_LAYOUT, layout); await kv.del(K_IMG(id)) },
    saveLayout: layout => kv.set(K_LAYOUT, layout),
    loadInk: async () => (await kv.get<Blob>(K_CANVAS)) || null,
    saveInk: blob => kv.set(K_CANVAS, blob),
    clearInk: () => kv.del(K_CANVAS),
    close: () => kv.close()
  }
}

/** 降级：IndexedDB 不可用时沿用 v1 的 localStorage 存法 */
export function localStore(ls: StorageLike): BoardStore {
  let cache: (BoardImageLayout & { src: string })[] = []
  const persist = () => ls.setItem(LS_LEGACY_IMAGES, JSON.stringify(cache.map(({ src, x, y, w }) => ({ src, x, y, w }))))
  const sync = (layout: BoardImageLayout[]) => {
    const byId = new Map(cache.map(c => [c.id, c]))
    cache = layout.filter(l => byId.has(l.id)).map(l => ({ ...l, src: byId.get(l.id)!.src }))
  }
  return {
    kind: 'local',
    async loadImages() {
      let legacy: LegacyImage[] = []
      try { legacy = JSON.parse(ls.getItem(LS_LEGACY_IMAGES) || '[]') } catch { legacy = [] }
      cache = []
      const out: BoardImage[] = []
      for (const it of Array.isArray(legacy) ? legacy : []) {
        try {
          const id = newId(), blob = dataURLToBlob(it.src)
          cache.push({ id, x: +it.x || 0, y: +it.y || 0, w: +it.w || 200, src: it.src })
          out.push({ id, x: +it.x || 0, y: +it.y || 0, w: +it.w || 200, blob })
        } catch { /* 跳过损坏项 */ }
      }
      return out
    },
    async addImage(img, layout) {
      cache.push({ id: img.id, x: img.x, y: img.y, w: img.w, src: await blobToDataURL(img.blob) })
      sync(layout); persist()
    },
    async removeImage(_id, layout) { sync(layout); persist() },
    async saveLayout(layout) { sync(layout); persist() },
    async loadInk() {
      const raw = ls.getItem(LS_LEGACY_CANVAS)
      if (!raw) return null
      try { return dataURLToBlob(raw) } catch { return null }
    },
    async saveInk(blob) { ls.setItem(LS_LEGACY_CANVAS, await blobToDataURL(blob)) },
    async clearInk() { ls.removeItem(LS_LEGACY_CANVAS) },
    close() { /* nothing */ }
  }
}

/** 打开便签存储：优先 IndexedDB（并迁移 v1 数据），不可用时降级 localStorage */
export async function openBoardStore(opts: { kvFactory?: () => Promise<KV | null>; ls?: StorageLike | null } = {}): Promise<BoardStore> {
  const ls = opts.ls === undefined ? safeLS() : opts.ls
  const kv = await (opts.kvFactory || (() => openKV('dqs-board', 'kv')))()
  if (!kv) {
    const mem = new Map<string, string>()
    return localStore(ls || { getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v) }, removeItem: k => { mem.delete(k) } })
  }
  if (ls) {
    try { await migrateLegacy(kv, ls) } catch (e) { console.warn('便签旧数据迁移失败，保留 localStorage 原数据，下次打开再试：', e) }
  }
  return idbStore(kv)
}

// ── 纯函数：给组件用，有单测 ──
/** 图片在画布内的显示位置：不超出画布，宽度至少 60 */
export function clampImage(l: BoardImageLayout, stageW: number, stageH: number): { x: number; y: number; w: number } {
  let { x, y, w } = l
  if (stageW && stageH) {
    w = Math.min(w, Math.max(60, stageW - 16))
    x = Math.min(Math.max(0, x), Math.max(0, stageW - w))
    y = Math.min(Math.max(0, y), Math.max(0, stageH - 40))
  }
  return { x, y, w }
}
/** 折叠时标题栏的摘要 */
export function boardPreview(memo: string, hasInk: boolean, imageCount: number): string {
  const parts: string[] = []
  const m = memo.trim()
  if (m) parts.push(m.split(/\n/)[0].slice(0, 24))
  if (hasInk) parts.push('有手写')
  if (imageCount) parts.push(imageCount + ' 张图片')
  return parts.length ? parts.join(' · ') : '点开记点什么'
}
/** 画布尺寸变化时按原比例居中缩放旧内容（不拉伸） */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  if (!srcW || !srcH) return { x: 0, y: 0, w: 0, h: 0 }
  const s = Math.min(dstW / srcW, dstH / srcH)
  const w = srcW * s, h = srcH * s
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}
