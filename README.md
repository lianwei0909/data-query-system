# Data Query System v2（Vue 3 + Vite + TypeScript）

## 开发
npm install
npm run dev        # 本地开发 http://localhost:5173
npm test           # 单元测试（vitest，76 项）
npm run typecheck  # 类型检查
npm run build      # 产物在 dist/，整个目录上传到 GitHub Pages 即可（base 为相对路径）
npx playwright install chromium   # 首次跑冒烟测试前装浏览器
npm run e2e        # 浏览器冒烟测试（先 build；自动起 vite preview）。E2E_HIGHS=1 时排班走真实 HiGHS 精确求解
npx playwright install chromium   # 首次跑冒烟测试前装浏览器
npm run e2e        # 浏览器冒烟测试（先 build；自动起 vite preview）。E2E_HIGHS=1 时排班走真实 HiGHS 精确求解

## 目录
src/core                 纯逻辑：日期 / 节假日 / 班次口径 / 存储合并 / 统计 / CSV / 字段提取 / IndexedDB / 便签存储（全部有单测）
src/converters           过审 / 不过审 转换配置（一份页面 + 两份配置）
src/solver/engine.js     排班算法：需求解析 / 建模 / HiGHS 精确求解 / 启发式兜底 / 校验 / Excel 导出（类型见 engine.d.ts、types.ts）
src/solver/schedulerStore.ts  排班页状态与持久化（人员提取、规则、跨周期衔接）
src/solver/*.worker.ts   求解 Web Worker；useSolver.ts 主线程调度（进度 / 取消）
src/components           NotesBoard（便签画板）、scheduler/*（规则 / 人员需求 / 结果表 / 校验报告）、UploadZone
src/views                5 个页面，按路由分包懒加载
public                   highs.js / highs.wasm（排班精确求解器，MIT）
e2e                      Playwright 冒烟测试：空数据 / 导入核对与撤销 / 日历 / 便签迁移 / 排班导出 / 双主题对比度 / 移动端
.github/workflows        ci.yml（PR 与非 main 分支检查）、deploy.yml（main：单测 → 构建 → 冒烟 → 发布 Pages）
e2e                      Playwright 冒烟测试：空数据 / 导入核对与撤销 / 日历 / 便签迁移 / 排班导出 / 双主题对比度 / 移动端
.github/workflows        ci.yml（PR 与非 main 分支检查）、deploy.yml（main：单测 → 构建 → 冒烟 → 发布 Pages）

## 数据兼容
localStorage 的 key 与 v1 完全一致（importedShiftData / viewer_name / scheduler_* / board_memo* / ui_theme），
老用户升级后数据原样可用；旧版不带年份的日期列会在首次打开时自动迁移。
便签的手写与粘贴图片存 IndexedDB（库名 dqs-board），首次打开自动从 localStorage 的 board_images / board_canvas 迁移，
迁移成功后才删除旧 key；浏览器不支持 IndexedDB 时仍按 v1 方式存 localStorage。

## 主题配色
文字颜色一律用 tokens.css 里的 *-text 变量（如 --accent-text、--err-text），不要把 --accent 等底色直接当文字色；
冒烟测试会逐个元素计算对比度（含渐变背景），低于 WCAG AA 会失败。

## 主题配色
文字颜色一律用 tokens.css 里的 *-text 变量（如 --accent-text、--err-text），不要把 --accent 等底色直接当文字色；
冒烟测试会逐个元素计算对比度（含渐变背景），低于 WCAG AA 会失败。

## 每年维护
src/core/holidays.ts 补充次年法定节假日（国务院办公厅公布后）。
