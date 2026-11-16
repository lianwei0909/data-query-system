// 全站提示（toast）与加载遮罩：单例，任何模块可调用；由 App.vue 渲染
import { reactive } from 'vue'

export type ToastType = 'success' | 'error' | 'info'
export const ui = reactive({
  toast: { show: false, msg: '', type: 'success' as ToastType },
  loader: { show: false, text: '处理中...' }
})

let timer: ReturnType<typeof setTimeout> | null = null
export function toast(msg: string, type: ToastType = 'success'): void {
  if (timer) clearTimeout(timer)
  ui.toast.show = false
  ui.toast.msg = msg
  ui.toast.type = type
  requestAnimationFrame(() => { ui.toast.show = true })
  timer = setTimeout(() => { ui.toast.show = false; timer = null }, type === 'error' ? 4500 : 2800)
}
export function showLoader(text = '处理中...'): void {
  ui.loader.text = text
  ui.loader.show = true
}
export function hideLoader(): void {
  ui.loader.show = false
}
