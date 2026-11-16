// 过审 / 不过审数据转换：两页 85% 相同的逻辑合并为「配置 + 通用页面」
// 差异只在：输出列、字段提取规则、统计口径、文件名前缀、主题色
import { extractFromStr } from '../core/jsonField'
import { formatTimeStamp } from '../core/text'

export interface ConverterConfig {
  id: 'approve' | 'reject'
  title: string
  desc: string
  icon: string
  accent: string
  filePrefix: string
  columns: string[]           // 输出列（空字符串 = 占位空列）
  columnLabels: string[]      // 预览表头
  extract: (row: Record<string, unknown>) => Record<string, string>
  stats: (rows: Record<string, string>[]) => { value: number; label: string; error?: boolean }[]
}

const text = (row: Record<string, unknown>, key: string): string => String(row[key] ?? '').trim()

export const APPROVE: ConverterConfig = {
  id: 'approve',
  title: '过审数据转换工具',
  desc: '上传过审明细（CSV / Excel），提取争议任务、内容与文本字段并导出',
  icon: '✅',
  accent: 'var(--green)',
  filePrefix: '转换结果_过审_',
  columns: ['TimeStamp', 'dispute_task_id', 'feed_id', '', '', '', 'evidence_text', 'pruned_desc'],
  columnLabels: ['TimeStamp', 'dispute_task_id', 'feed_id', '空', '空', '空', 'evidence_text', 'pruned_desc'],
  extract(row) {
    const out: Record<string, string> = { TimeStamp: formatTimeStamp(text(row, 'TimeStamp')), dispute_task_id: '', feed_id: '', evidence_text: '', pruned_desc: '' }
    const cd = text(row, 'content_data')
    if (cd) {
      out.dispute_task_id = extractFromStr(cd, 'dispute_task_id') || ''
      out.feed_id = extractFromStr(cd, 'feed_id') || ''
      out.evidence_text = extractFromStr(cd, 'evidence_text') || ''
    }
    const ad = text(row, 'answer_data')
    if (ad) out.pruned_desc = extractFromStr(ad, 'pruned_desc') || ''
    return out
  },
  stats: rows => [
    { value: rows.length, label: '总数据量' },
    { value: rows.filter(r => r.dispute_task_id).length, label: '争议任务数' },
    { value: rows.filter(r => !r.feed_id || !r.dispute_task_id || !r.evidence_text).length, label: '转化错误', error: true },
    { value: rows.filter(r => r.pruned_desc || r.evidence_text).length, label: '含文本数据' }
  ]
}

export const REJECT: ConverterConfig = {
  id: 'reject',
  title: '不过审数据转换工具',
  desc: '上传不过审明细（CSV / Excel），提取争议任务、操作人与证据文本并导出',
  icon: '✖',
  accent: 'var(--red)',
  filePrefix: '转换结果_不过审_',
  columns: ['TimeStamp', 'dispute_task_id', 'feed_id', 'operator', '', 'evidence_text'],
  columnLabels: ['TimeStamp', 'dispute_task_id', 'feed_id', 'operator', '', 'evidence_text'],
  extract(row) {
    const out: Record<string, string> = {
      TimeStamp: formatTimeStamp(text(row, 'TimeStamp'), true),   // 保留时分秒
      dispute_task_id: '', feed_id: '', operator: text(row, 'operator'), evidence_text: ''
    }
    const cd = text(row, 'content_data')
    if (cd) {
      out.feed_id = extractFromStr(cd, 'feed_id') || ''
      out.dispute_task_id = extractFromStr(cd, 'dispute_task_id') || ''
      out.evidence_text = extractFromStr(cd, 'evidence_text') || ''
    }
    const ad = text(row, 'answer_data')
    if (ad) {   // 内容字段缺失时用 answer_data 兜底
      if (!out.feed_id) out.feed_id = extractFromStr(ad, 'feed_id') || ''
      if (!out.dispute_task_id) out.dispute_task_id = extractFromStr(ad, 'dispute_task_id') || ''
      if (!out.evidence_text) out.evidence_text = extractFromStr(ad, 'pruned_desc') || ''
    }
    return out
  },
  stats: rows => [
    { value: rows.length, label: '总数据量' },
    { value: rows.filter(r => r.dispute_task_id).length, label: '争议任务数' },
    { value: rows.filter(r => !r.feed_id || !r.dispute_task_id).length, label: '转化错误', error: true },
    { value: rows.filter(r => r.evidence_text).length, label: '含文本数据' }
  ]
}

export const CONVERTERS: Record<ConverterConfig['id'], ConverterConfig> = { approve: APPROVE, reject: REJECT }
