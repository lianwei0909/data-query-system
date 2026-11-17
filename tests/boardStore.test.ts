import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { openKV, type KV } from '../src/core/idb'
import {
  blobToDataURL, boardPreview, clampImage, dataURLToBlob, fitRect, localStore, migrateLegacy, openBoardStore,
  type StorageLike
} from '../src/core/boardStore'

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
function memLS(init: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(init))
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: k => { map.delete(k) } }
}
let n = 0
const freshKV = () => openKV('test-' + (++n), 'kv') as Promise<KV>

describe('dataURL ⇄ Blob', () => {
  it('base64 往返无损', async () => {
    const b = dataURLToBlob(PNG_1PX)
    expect(b.type).toBe('image/png')
    expect(await blobToDataURL(b)).toBe(PNG_1PX)
  })
  it('非法 dataURL 抛错', () => {
    expect(() => dataURLToBlob('hello')).toThrow()
  })
})

describe('v1 localStorage → IndexedDB 迁移', () => {
  it('图片与手写迁入 IndexedDB，成功后删除旧 key，文字便签不动', async () => {
    const ls = memLS({
      board_images: JSON.stringify([{ src: PNG_1PX, x: 10, y: 20, w: 150 }, { src: PNG_1PX, x: 1, y: 2, w: 3 }]),
      board_canvas: PNG_1PX,
      board_memo: '记得交周报'
    })
    const kv = await freshKV()
    const store = await openBoardStore({ kvFactory: async () => kv, ls })
    expect(store.kind).toBe('idb')
    const imgs = await store.loadImages()
    expect(imgs.map(i => [i.x, i.y, i.w])).toEqual([[10, 20, 150], [1, 2, 3]])
    expect(await blobToDataURL(imgs[0].blob)).toBe(PNG_1PX)
    expect(await blobToDataURL((await store.loadInk())!)).toBe(PNG_1PX)
    expect(ls.map.has('board_images')).toBe(false)
    expect(ls.map.has('board_canvas')).toBe(false)
    expect(ls.map.get('board_memo')).toBe('记得交周报')
  })
  it('写 IndexedDB 失败时保留 localStorage 原数据（下次再迁）', async () => {
    const ls = memLS({ board_images: JSON.stringify([{ src: PNG_1PX, x: 0, y: 0, w: 100 }]) })
    const kv = await freshKV()
    const broken: KV = { ...kv, set: async () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e } }
    await expect(migrateLegacy(broken, ls)).rejects.toThrow()
    expect(ls.map.has('board_images')).toBe(true)
  })
  it('重复打开不会重复迁移', async () => {
    const ls = memLS({ board_images: JSON.stringify([{ src: PNG_1PX, x: 0, y: 0, w: 100 }]) })
    const kv = await freshKV()
    await openBoardStore({ kvFactory: async () => kv, ls })
    const again = await openBoardStore({ kvFactory: async () => kv, ls })
    expect((await again.loadImages()).length).toBe(1)
  })
  it('损坏的旧数据被跳过，不阻塞迁移', async () => {
    const ls = memLS({ board_images: '[{"src":"bad"},{"src":"' + PNG_1PX + '","x":5,"y":5,"w":50}]', board_canvas: 'garbage' })
    const kv = await freshKV()
    const store = await openBoardStore({ kvFactory: async () => kv, ls })
    expect((await store.loadImages()).length).toBe(1)
    expect(await store.loadInk()).toBeNull()
    expect(ls.map.size).toBe(0)
  })
})

describe('IndexedDB 存储读写', () => {
  it('增删图片、保存布局、手写存取', async () => {
    const kv = await freshKV()
    const s = await openBoardStore({ kvFactory: async () => kv, ls: memLS() })
    const blob = dataURLToBlob(PNG_1PX)
    await s.addImage({ id: 'a', x: 1, y: 1, w: 100, blob }, [{ id: 'a', x: 1, y: 1, w: 100 }])
    await s.addImage({ id: 'b', x: 2, y: 2, w: 100, blob }, [{ id: 'a', x: 1, y: 1, w: 100 }, { id: 'b', x: 2, y: 2, w: 100 }])
    await s.saveLayout([{ id: 'a', x: 50, y: 60, w: 70 }, { id: 'b', x: 2, y: 2, w: 100 }])
    await s.removeImage('b', [{ id: 'a', x: 50, y: 60, w: 70 }])
    const imgs = await s.loadImages()
    expect(imgs.map(i => [i.id, i.x, i.y, i.w])).toEqual([['a', 50, 60, 70]])
    expect(await kv.keys()).not.toContain('board_img:b')
    await s.saveInk(blob)
    expect(await s.loadInk()).not.toBeNull()
    await s.clearInk()
    expect(await s.loadInk()).toBeNull()
  })
  it('IndexedDB 不可用时降级为 v1 的 localStorage 存法', async () => {
    const ls = memLS()
    const s = await openBoardStore({ kvFactory: async () => null, ls })
    expect(s.kind).toBe('local')
    await s.addImage({ id: 'x', x: 3, y: 4, w: 120, blob: dataURLToBlob(PNG_1PX) }, [{ id: 'x', x: 3, y: 4, w: 120 }])
    expect(JSON.parse(ls.map.get('board_images')!)).toEqual([{ src: PNG_1PX, x: 3, y: 4, w: 120 }])
    const again = localStore(ls)
    expect((await again.loadImages())[0]).toMatchObject({ x: 3, y: 4, w: 120 })
  })
})

describe('便签纯函数', () => {
  it('图片位置收进画布内', () => {
    expect(clampImage({ id: '', x: -20, y: 900, w: 500 }, 300, 400)).toEqual({ x: 0, y: 360, w: 284 })
    expect(clampImage({ id: '', x: 10, y: 10, w: 100 }, 0, 0)).toEqual({ x: 10, y: 10, w: 100 })
  })
  it('折叠摘要', () => {
    expect(boardPreview('', false, 0)).toBe('点开记点什么')
    expect(boardPreview('  第一行很长很长很长很长很长很长很长很长很长很长\n第二行', true, 2)).toBe('第一行很长很长很长很长很长很长很长很长很长很长'.slice(0, 24) + ' · 有手写 · 2 张图片')
  })
  it('等比居中缩放', () => {
    expect(fitRect(200, 100, 100, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 })
    expect(fitRect(0, 0, 100, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})
