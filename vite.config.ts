import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// base './'：产物使用相对路径，可直接上传到 GitHub Pages 子路径（/data-query-system/）
// worker.format 'iife'：求解 Worker 为经典 Worker，运行时用 importScripts 加载 public/highs.js
export default defineConfig({
  base: './',
  plugins: [vue()],
  worker: { format: 'iife' },
  build: { target: 'es2019', cssTarget: 'chrome87', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] }
})
