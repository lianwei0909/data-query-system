<script setup lang="ts">
// 过审 / 不过审共用一个页面：差异全部来自 converters 配置（输出列、提取规则、统计口径、文件名）
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import UploadZone from '../components/UploadZone.vue'
import { CONVERTERS } from '../converters'
import { readTableFile, exportRows } from '../core/readFile'
import { localDateStr } from '../core/date'
import { toast, showLoader, hideLoader } from '../core/notify'

const route = useRoute()
const cfg = computed(() => CONVERTERS[(route.name === 'reject' ? 'reject' : 'approve')])
const rows = ref<Record<string, string>[]>([])
const page = ref(1)
const PAGE_SIZE = 20
const MAX_CELL = 50

watch(() => route.name, () => { rows.value = []; page.value = 1 })   // 两个模块切换时清空

const total = computed(() => Math.max(1, Math.ceil(rows.value.length / PAGE_SIZE)))
const pageRows = computed(() => rows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const stats = computed(() => cfg.value.stats(rows.value))
const cut = (v: string) => (v.length > MAX_CELL ? v.slice(0, MAX_CELL) + '...' : v)

async function onFile(f: File) {
  showLoader(`正在读取 ${f.name}…`)
  try {
    const data = await readTableFile(f)
    const out = data.map(cfg.value.extract).filter(r => r.TimeStamp)
    if (!out.length) { toast('⚠️ 未找到有效数据，请检查文件格式', 'error'); return }
    rows.value = out; page.value = 1
    toast(`✅ 成功解析 ${out.length} 条数据`)
  } catch (e) {
    toast((e as Error)?.message || '文件解析失败', 'error')
  } finally { hideLoader() }
}

async function doExport() {
  if (!rows.value.length) { toast('请先上传文件', 'error'); return }
  showLoader('正在生成 Excel 文件…')
  try {
    const name = cfg.value.filePrefix + localDateStr() + '.xlsx'   // 本地日期，不再用 UTC
    await exportRows(rows.value, cfg.value.columns, name)
    toast(`✅ 已导出 ${name}（共 ${rows.value.length} 条）`)   // 导出成功后再提示，且不自动清空
  } catch (e) {
    toast('转换失败：' + ((e as Error)?.message || e), 'error')
  } finally { hideLoader() }
}
</script>

<template>
  <div class="sub-page-body" :style="{ '--conv-accent': cfg.accent }">
    <div class="container">
      <div class="page-intro">
        <h2>{{ cfg.icon }} {{ cfg.title }}</h2>
        <p>{{ cfg.desc }}</p>
      </div>
      <div class="upload-section">
        <UploadZone @file="onFile" />
      </div>

      <div v-if="rows.length" class="preview-section active">
        <div class="stats-row">
          <div v-for="s in stats" :key="s.label" class="stat-card" :class="{ 'stat-error': s.error }">
            <div class="stat-number">{{ s.value }}</div>
            <div class="stat-label">{{ s.label }}</div>
          </div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th v-for="(c, i) in cfg.columnLabels" :key="i">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, ri) in pageRows" :key="ri">
                <td v-for="(c, ci) in cfg.columns" :key="ci" :title="c ? r[c] : ''">{{ c ? cut(r[c] || '') : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="rows.length > PAGE_SIZE" class="pagination-controls">
          <button class="page-btn" :disabled="page <= 1" @click="page--">◀ 上一页</button>
          <span class="page-info">第 {{ page }} / {{ total }} 页　（共 {{ rows.length }} 条）</span>
          <button class="page-btn" :disabled="page >= total" @click="page++">下一页 ▶</button>
        </div>
        <div class="action-bar">
          <button class="btn btn-primary" @click="doExport">⚡ 导出 Excel</button>
          <button class="btn btn-secondary" @click="rows = []">🔄 重新上传</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat-card { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.stat-error .stat-number { color: var(--red-text); }
.page-intro h2 { color: var(--text-primary); }
</style>
