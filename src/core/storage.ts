// localStorage 安全封装：隐私模式 / 配额溢出都不抛出，由调用方决定是否提示
export function readLS(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
export function writeLS(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true } catch { return false }
}
export function removeLS(key: string): void {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}
export function readJSON<T>(key: string, fallback: T): T {
  const raw = readLS(key)
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}
/** 存储满时提示一次（10 秒内不重复） */
let notifiedAt = 0
export function notifyStorageFull(what: string, notify: (msg: string, type?: 'success' | 'error' | 'info') => void): void {
  const now = Date.now()
  if (now - notifiedAt < 10000) return
  notifiedAt = now
  notify(`⚠ ${what}未能保存：浏览器存储空间已满，请清理后重试`, 'error')
}

/** 可注入的存储接口（测试用内存实现，页面用 browserStorage） */
export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}
/** 安全的 localStorage：读失败返回 null，写失败抛出（由调用方决定是否提示） */
export const browserStorage: StorageLike = {
  getItem: k => readLS(k),
  setItem: (k, v) => { localStorage.setItem(k, v) },
  removeItem: k => removeLS(k)
}
