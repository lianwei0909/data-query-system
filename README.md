# Data Query System v2（Vue 3 + Vite + TypeScript）

## 开发
npm install
npm run dev        # 本地开发 http://localhost:5173
npm test           # 单元测试（vitest，40 项）
npm run typecheck  # 类型检查
npm run build      # 产物在 dist/，整个目录上传到 GitHub Pages 即可（base 为相对路径）

## 目录
src/core        纯逻辑：日期 / 节假日 / 班次口径 / 存储合并 / 统计 / CSV / 字段提取（全部有单测）
src/converters  过审 / 不过审 转换配置（一份页面 + 两份配置）
src/solver      排班求解内核（遗留 JS）+ Web Worker + 主线程调度（进度 / 取消）
src/legacy      便签画板（遗留 JS，卸载时清理全局监听）
src/views       5 个页面，按路由分包懒加载
public          highs.js / highs.wasm（排班精确求解器，MIT）

## 数据兼容
localStorage 的 key 与 v1 完全一致（importedShiftData / viewer_name / scheduler_* / board_* / ui_theme），
老用户升级后数据原样可用；旧版不带年份的日期列会在首次打开时自动迁移。

## 每年维护
src/core/holidays.ts 补充次年法定节假日（国务院办公厅公布后）。
