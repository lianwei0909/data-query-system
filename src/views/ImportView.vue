<script setup lang="ts">
// 数据导入：解析班表 → 导入前核对（新增 / 覆盖明细）→ 确认后按人按日期合并写入 → 本页内可撤销
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import UploadZone from '../components/UploadZone.vue'
import { readTableFileAsSheet } from '../core/readFile'
import { diffShiftRows, importShiftRows, loadShiftRows, replaceShiftRows, shiftFilledRange, type ShiftDiff } from '../core/shiftStore'
import { listPeople, personLabel, type ShiftRow } from '../core/shift'
import { inferDateKeys, isYmdKey } from '../core/date'
import { readLS, writeLS, removeLS } from '../core/storage'
import { toast, showLoader, hideLoader } from '../core/notify'

type Row = Record<string, unknown>
const rows = ref<Row[]>([])
const columns = ref<string[]>([])
const existing = ref(shiftFilledRange(loadShiftRows()))
const importing = ref(false)
const diff = ref<ShiftDiff | null>(null)
/** 本次导入前的完整班表，用于撤销（只保存在内存里，离开本页即失效） */
const backup = ref<ShiftRow[] | null>(null)
const CHANGE_LIMIT = 50
const WHO_KEY = 'viewer_name'
const router = useRouter()
/** 本次自动选中的查看人（撤销导入时要清掉，避免留下一个班表里不存在的人） */
const autoViewer = ref<string | null>(null)

interface ImportSummary {
  rows: number; cells: number; people: number; newPeople: number; unnamed: number; range: string; viewer: string; hadOld: boolean
}
/** 导入完成后保留一份自查摘要：光看「导入完成」很难判断新班次到底有没有落到日历里 */
const summary = ref<ImportSummary | null>(null)
/** 文件里真正填了班次的格子数（空日期列不算） */
function countCells(list: Row[]): number {
  let n = 0
  for (const r of list) for (const k of Object.keys(r)) if (isYmdKey(k) && String(r[k] ?? '').trim()) n++
  return n
}

/** 导入后若没选过「查看谁」、或原来选的人不在班表里，默认选中第一位真人，首页日历才会画出班次 */
function ensureViewer(merged: ShiftRow[]): string {
  const people = listPeople(merged)
  if (!people.length) return ''
  const cur = (readLS(WHO_KEY) || '').trim()
  if (cur && people.some(p => p.en.toLowerCase() === cur.toLowerCase())) return ''
  const first = people[0]
  writeLS(WHO_KEY, first.en)
  autoViewer.value = first.en
  return personLabel(first)
}
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
    const rg = shiftFilledRange(rows.value)
    toast(`文件解析完成：${rows.value.length} 行，${dateCols.value.length} 个日期列` + (rg ? `（其中 ${rg.from} ~ ${rg.to} 填了班次）` : '（没有填班次）') + '；请点击下方「✅ 确认导入」写入班表', 'info')
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
    const filled = shiftFilledRange(merged)
    existing.value = filled
    const n = diff.value?.changed.length || 0
    const newPeople = diff.value?.newPeople.length || 0
    const unnamed = diff.value?.unnamed || 0
    const cells = countCells(rows.value)
    const auto = ensureViewer(merged)
    summary.value = {
      rows: rows.value.length, cells, people: listPeople(merged).length, newPeople, unnamed, hadOld,
      range: filled ? `${filled.from} ~ ${filled.to}（${filled.days} 天有班次）` : '（文件里没有填班次）',
      viewer: readLS(WHO_KEY) || ''
    }
    toast(`✅ 导入完成：本次 ${rows.value.length} 行 / ${cells} 个班次` + (hadOld ? '，已与原有班表合并' : '') + (n ? `，覆盖 ${n} 格` : '') + (filled ? `；实际有班次 ${filled.from} ~ ${filled.to}` : '；文件里没有填班次') + (auto ? `；已默认查看 ${auto}` : ''), 'success')
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
    if (autoViewer.value && (readLS(WHO_KEY) || '') === autoViewer.value) removeLS(WHO_KEY)
    autoViewer.value = null
    existing.value = shiftFilledRange(backup.value)
    summary.value = null
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
        <span>✅ 已写入班表，首页日历可直接查看。如果导入错了文件，可以恢复到导入前的状态（离开本页后无法撤销）。</span>
        <div class="undo-actions">
          <button class="btn btn-secondary" type="button" @click="router.push('/')">🏠 前往首页查看</button>
          <button class="btn btn-secondary" type="button" @click="undoImport">↩ 撤销本次导入</button>
        </div>
      </div>

      <div v-if="summary" class="preview-section active import-summary" aria-live="polite">
        <div class="section-title">导入结果自查</div>
        <div class="summary-grid">
          <div><b>{{ summary.rows }}</b> 行数据</div>
          <div><b>{{ summary.cells }}</b> 个班次格</div>
          <div><b>{{ summary.people }}</b> 名人员</div>
          <div :class="{ warn: summary.hadOld && summary.newPeople }"><b>{{ summary.newPeople }}</b> 名新人员</div>
          <div :class="{ warn: summary.unnamed }"><b>{{ summary.unnamed }}</b> 行无法按人合并</div>
        </div>
        <div class="hint-text">实际有班次的日期：{{ summary.range }}　·　当前查看：{{ summary.viewer || '未设置（首页日历不会显示班次）' }}</div>
        <div v-if="summary.unnamed" class="hint-text diff-warn">
          ⚠ 有 {{ summary.unnamed }} 行识别不出人员（文件名里没有「英文名 / 中文名 / 企业名」这样的列）。这些行无法按人合并，会作为独立行保存，日历里可能看不到新导入的班次。
        </div>
        <div v-else-if="summary.hadOld && summary.newPeople" class="hint-text diff-warn">
          ⚠ 本次有 {{ summary.newPeople }} 名新人员。如果这是给已有人员补后续班次，说明文件里的「英文名 / 中文名」与现有班表对不上，新数据被存成了独立行，日历里看到的仍是原来那个人；请用与现有班表一致的姓名列重新导出再导入。
        </div>
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
.undo-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.import-summary { text-align: left; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 4px 0 12px; }
.summary-grid > div { padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg2); font-size: 12.5px; color: var(--text-secondary); }
.summary-grid b { margin-right: 4px; font-size: 18px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.summary-grid .warn { border-color: var(--warn-text); background: var(--gold-bg); color: var(--warn-text); }
.summary-grid .warn b { color: var(--warn-text); }
</style>
