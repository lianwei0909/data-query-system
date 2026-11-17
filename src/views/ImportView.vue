<script setup lang="ts">
// 数据导入：解析班表 → 导入前核对（新增 / 覆盖明细）→ 确认后按人按日期合并写入 → 本页内可撤销
import { computed, ref } from 'vue'
import UploadZone from '../components/UploadZone.vue'
import { readTableFileAsSheet } from '../core/readFile'
import { diffShiftRows, importShiftRows, loadShiftRows, replaceShiftRows, shiftDateRange, type ShiftDiff } from '../core/shiftStore'
import type { ShiftRow } from '../core/shift'
import { inferDateKeys, isYmdKey } from '../core/date'
import { toast, showLoader, hideLoader } from '../core/notify'

type Row = Record<string, unknown>
const rows = ref<Row[]>([])
const columns = ref<string[]>([])
const existing = ref(shiftDateRange(loadShiftRows()))
const importing = ref(false)
const diff = ref<ShiftDiff | null>(null)
/** 本次导入前的完整班表，用于撤销（只保存在内存里，离开本页即失效） */
const backup = ref<ShiftRow[] | null>(null)
const CHANGE_LIMIT = 50
const noEffect = computed(() => !!diff.value && !diff.value.newPeople.length && !diff.value.added && !diff.value.changed.length)

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
    diff.value = diffShiftRows(loadShiftRows(), rows.value)
    backup.value = null
    const rg = shiftDateRange(rows.value)
    toast(`解析成功：${rows.value.length} 行，${dateCols.value.length} 个日期列` + (rg ? `（${rg.from} ~ ${rg.to}）` : ''), 'success')
  } catch (e) {
    toast('解析失败：' + ((e as Error)?.message || '未知错误'), 'error')
  } finally { hideLoader() }
}

function reset() { rows.value = []; columns.value = []; diff.value = null }

function doImport() {
  if (!rows.value.length) return
  importing.value = true
  const before = loadShiftRows()
  try {
    const { merged, hadOld } = importShiftRows(rows.value)
    const all = shiftDateRange(merged)
    existing.value = all
    const n = diff.value?.changed.length || 0
    toast(`✅ 导入完成：本次 ${rows.value.length} 行` + (hadOld ? '，已与原有班表合并' : '') + (n ? `，覆盖 ${n} 格` : '') + (all ? `，现有数据 ${all.from} ~ ${all.to}` : ''), 'success')
    backup.value = before
    reset()
  } catch (e) {
    const err = e as Error & { name?: string }
    toast(err?.name === 'QuotaExceededError' ? '数据过大，超出浏览器存储限制（约 5MB）' : '导入失败：' + (err?.message || '未知错误'), 'error')
  } finally { importing.value = false }
}

function undoImport() {
  if (!backup.value) return
  try {
    replaceShiftRows(backup.value)
    existing.value = shiftDateRange(backup.value)
    backup.value = null
    toast('已撤销本次导入，班表恢复到导入前的状态', 'success')
  } catch (e) {
    toast('撤销失败：' + ((e as Error)?.message || '未知错误'), 'error')
  }
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

      <div v-if="backup" class="preview-section active undo-bar" role="status">
        <span>已导入。如果导入错了文件，可以恢复到导入前的状态（离开本页后无法撤销）。</span>
        <button class="btn btn-secondary" type="button" @click="undoImport">↩ 撤销本次导入</button>
      </div>

      <div v-if="diff" class="preview-section active diff-card" aria-live="polite">
        <div class="section-title">导入前核对<span v-if="diff.range" class="row-count">本次文件 {{ diff.range.from }} ~ {{ diff.range.to }}（{{ diff.range.days }} 天）</span></div>
        <div class="diff-chips">
          <span class="diff-chip"><b>{{ diff.newPeople.length }}</b> 名新人员</span>
          <span class="diff-chip"><b>{{ diff.newDates }}</b> 个新日期</span>
          <span class="diff-chip"><b>{{ diff.added }}</b> 格补充空白</span>
          <span class="diff-chip" :class="{ warn: diff.changed.length }"><b>{{ diff.changed.length }}</b> 格覆盖已有班次</span>
          <span class="diff-chip"><b>{{ diff.unchanged }}</b> 格与现有相同</span>
        </div>
        <div v-if="diff.newPeople.length" class="hint-text">新人员：{{ diff.newPeople.slice(0, 12).join('、') }}{{ diff.newPeople.length > 12 ? ` 等 ${diff.newPeople.length} 人` : '' }}</div>
        <div v-if="diff.unnamed" class="hint-text diff-warn">⚠ 有 {{ diff.unnamed }} 行没有英文名 / 中文名 / 企业名，无法按人合并，导入后会作为单独的行保留</div>
        <div v-if="noEffect" class="hint-text">与现有班表完全一致，导入不会产生任何变化。</div>
        <template v-if="diff.changed.length">
          <div class="hint-text diff-warn">⚠ 以下已有班次会被新文件覆盖（文件里的空白格不会清空原有班次）：</div>
          <div class="table-wrapper diff-table">
            <table>
              <thead><tr><th>日期</th><th>人员</th><th>原班次</th><th>新班次</th></tr></thead>
              <tbody>
                <tr v-for="(c, i) in diff.changed.slice(0, CHANGE_LIMIT)" :key="i">
                  <td>{{ c.date }}</td><td>{{ c.person }}</td><td class="diff-from">{{ c.from }}</td><td class="diff-to">{{ c.to }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="diff.changed.length > CHANGE_LIMIT" class="hint-text">…还有 {{ diff.changed.length - CHANGE_LIMIT }} 格未列出</div>
        </template>
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
          <button class="btn-import" :disabled="importing" @click="doImport">✅ 确认导入{{ diff && diff.changed.length ? `（覆盖 ${diff.changed.length} 格）` : '' }}</button>
          <button class="btn btn-secondary" @click="reset">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-count { margin-left: 10px; font-size: 12.5px; font-weight: 400; color: var(--text-muted); }
.diff-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 10px; }
.diff-chip { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--card-bg2); font-size: 13px; color: var(--text-secondary); }
.diff-chip b { color: var(--text-primary); margin-right: 2px; }
.diff-chip.warn { border-color: var(--warn-text); background: var(--gold-bg); color: var(--warn-text); }
.diff-chip.warn b { color: var(--warn-text); }
.diff-warn { color: var(--warn-text); }
.diff-table { max-height: 320px; margin-top: 6px; }
.diff-from { color: var(--text-muted); text-decoration: line-through; }
.diff-to { color: var(--text-primary); font-weight: 600; }
.undo-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13.5px; color: var(--text-secondary); }
</style>
