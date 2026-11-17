// 极简 IndexedDB 键值封装（无第三方依赖）：一个库一个 object store，值可以是 Blob / 数组 / 对象
// 浏览器不支持或被禁用（部分隐私模式）时 openKV 返回 null，由调用方降级到 localStorage
export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
  keys(): Promise<string[]>
  close(): void
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export function openKV(dbName = 'dqs', store = 'kv'): Promise<KV | null> {
  const idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (!idb) return Promise.resolve(null)
  return new Promise(resolve => {
    let open: IDBOpenDBRequest
    try { open = idb.open(dbName, 1) } catch { resolve(null); return }
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store)
    }
    open.onerror = () => resolve(null)
    open.onblocked = () => resolve(null)
    open.onsuccess = () => {
      const db = open.result
      const tx = (mode: IDBTransactionMode) => db.transaction(store, mode).objectStore(store)
      // 写操作等事务 complete 再返回：保证数据真正落盘（配额不足会在这里抛 QuotaExceededError）
      const write = (fn: (s: IDBObjectStore) => void) => new Promise<void>((res, rej) => {
        const t = db.transaction(store, 'readwrite')
        t.oncomplete = () => res()
        t.onerror = () => rej(t.error)
        t.onabort = () => rej(t.error || new Error('IndexedDB 事务中止'))
        fn(t.objectStore(store))
      })
      resolve({
        get: <T>(key: string) => req(tx('readonly').get(key)) as Promise<T | undefined>,
        set: (key, value) => write(s => { s.put(value, key) }),
        del: key => write(s => { s.delete(key) }),
        keys: () => req(tx('readonly').getAllKeys()).then(ks => ks.map(String)),
        close: () => db.close()
      })
    }
  })
}

export function isQuotaError(e: unknown): boolean {
  const n = (e as { name?: string })?.name || ''
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED'
}
