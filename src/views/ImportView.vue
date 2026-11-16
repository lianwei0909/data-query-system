<script setup lang="ts">
// 数据导入：解析班表 → 预览 → 与已有班表按人按日期合并写入（不再整体覆盖）
import { computed, ref } from 'vue'
import UploadZone from '../components/UploadZone.vue'
import { readTableFileAsSheet } from '../core/readFile'
import { importShiftRows, loadShiftRows, shiftDateRange } from '../core/shiftStore'
import { inferDateKeys, isYmdKey } from '../core/date'
import { toast, showLoader, hideLoader } from '../core/notify'

type Row = Record<string, unknown>
const rows = ref<Row[]>([])
const columns = ref<string[]>([])
const existing = ref(shiftDateRange(loadShiftRows()))
const importing = ref(false)

const dateCols = computed(() => columns.value.filter(k => isYmdKey(k)))
const preview = computed(() => rows.value.slice(0, 30))

/** 识别日期列（表头是日期字符串），把列名统一成 YYYY-MM-DD */
function normalizeSheet(json: Row[]): Row[] {
  if (!json.length) return []
  const keys = Object.keys(json[0])
  const map = inferDateKeys(keys)
  const dateKeys = keys.filter(k => map[k])
  if (!dateKeys.length) return []
  return json.map(r => {
    const o: Row = {}
    for (const k of Object.keys(r)) o[map[k] || k] = r[k]
    return o
  })
}

/** 姓名列：按表头文字识别，兼容合并表头退化 */
function nameCols(json: Row[]): { en: string | null; cn: string | null } {
  const keys = Object.keys(json[0] || {})
  const find = (...hints: string[]) => keys.find(k => hints.some(h => k.includes(h))) ?? null
  return { en: find('英文'), cn: find('中文名', '中文', '姓名') }
}

async function onFile(f: File) {
  showLoader(`正在解析 ${f.name}…`)
  try {
    const json = await readTableFileAsSheet(f)
    if (!json.length) { toast('文件内容为空', 'error'); return }
    const normalized = normalizeSheet(json)
    if (!normalized.length) { toast('未检测到日期列（如 11月21日 或 2026-11-21），请确认上传的是班表文件', 'error'); return }
    const nc = nameCols(json)
    // 过滤表尾备注行
    const first = (r: Row) => String((nc.en && r[nc.en]) || (nc.cn && r[nc.cn]) || '').trim()
    rows.value = normalized.filter(r => !first(r).includes('备注'))
    columns.value = Object.keys(rows.value[0] || {})
    const rg = shiftDateRange(rows.value)
    toast(`解析成功：${rows.value.length} 行，${dateCols.value.length} 个日期列` + (rg ? `（${rg.from} ~ ${rg.to}）` : ''), 'success')
  } catch (e) {
    toast('解析失败：' + ((e as Error)?.message || '未知错误'), 'error')
  } finally { hideLoader() }
}

function doImport() {
  if (!rows.value.length) return
  importing.value = true
  try {
    const { merged, hadOld } = importShiftRows(rows.value)
    const all = shiftDateRange(merged)
    existing.value = all
    toast(`✅ 导入完成：本次 ${rows.value.length} 行` + (hadOld ? '，已与原有班表合并' : '') + (all ? `，现有数据 ${all.from} ~ ${all.to}` : ''), 'success')
    rows.value = []; columns.value = []
  } catch (e) {
    const err = e as Error & { name?: string }
    toast(err?.name === 'QuotaExceededError' ? '数据过大，超出浏览器存储限制（约 5MB）' : '导入失败：' + (err?.message || '未知错误'), 'error')
  } finally { importing.value = false }
}
</script>

<template>
  <div class="sub-page-body">
    <div class="container">
      <div class="page-intro">
        <h2>数据导入</h2>
        <p>上传往期班表（CSV / Excel），首页日历与智能排班都从这里取数；重复导入会按人员与日期合并</p>
      </div>

      <div v-if="existing" class="preview-section active">
        <div class="hint-text">当前已有班表：{{ existing.from }} ~ {{ existing.to }}（{{ existing.days }} 天）</div>
      </div>

      <div class="upload-section">
        <UploadZone title="把班表文件拖到这里，或点击选择" @file="onFile" />
      </div>

      <div v-if="rows.length" class="table-section visible">
        <div class="section-title">数据预览<span class="row-count">{{ rows.length }} 行 · {{ dateCols.length }} 个日期列</span></div>
        <div class="table-wrapper">
          <table>
            <thead><tr><th v-for="c in columns" :key="c">{{ c }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in preview" :key="i"><td v-for="c in columns" :key="c">{{ r[c] }}</td></tr></tbody>
          </table>
        </div>
        <div class="action-bar">
          <button class="btn-import" :disabled="importing" @click="doImport">✅ 确认导入</button>
          <button class="btn btn-secondary" @click="rows = []; columns = []">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-count { margin-left: 10px; font-size: 12.5px; font-weight: 400; color: var(--text-muted); }
</style>
