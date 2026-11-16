import { ref } from 'vue'
import { readLS, writeLS } from '../core/storage'

export type Theme = 'aurora' | 'paper'
const KEY = 'ui_theme'
export const theme = ref<Theme>(readLS(KEY) === 'paper' ? 'paper' : 'aurora')

export function applyTheme(t: Theme): void {
  theme.value = t
  if (t === 'paper') document.documentElement.setAttribute('data-theme', 'paper')
  else document.documentElement.removeAttribute('data-theme')
  writeLS(KEY, t)
}
export function initTheme(): void {
  applyTheme(readLS(KEY) === 'paper' ? 'paper' : 'aurora')
}
export function toggleTheme(): void {
  applyTheme(theme.value === 'paper' ? 'aurora' : 'paper')
}
