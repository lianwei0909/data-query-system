// 导入班表的文件解析：日期表头必须原样识别成 YYYY-MM-DD（曾被 SheetJS 转成 11/19/26 导致「未检测到日期列」）
import { describe, expect, it } from 'vitest'
import { readTableFileAsSheet, normalizeScheduleExport } from '../src/core/readFile'
import { inferDateKeys } from '../src/core/date'
import { loadXlsx } from '../src/core/xlsx'

const csvFile = (text: string, name = '班表.csv') => new File([text], name, { type: 'text/csv' })

async function xlsxFile(header: Record<string, unknown>[], date1904 = false): Promise<File> {
  const XLSX = await loadXlsx()
  const ws = XLSX.utils.aoa_to_sheet([header.map(() => ''), ['alice', '白班', '休', '小夜班3'].slice(0, header.length)])
  header.forEach((cell, c) => { ws[XLSX.utils.encode_cell({ r: 0, c })] = cell })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  if (date1904) wb.Workbook = { WBProps: { date1904: true } }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([buf], '班表.xlsx')
}

describe('readTableFileAsSheet', () => {
  it('CSV：ISO / 斜杠 / 中文日期表头原样保留，前导零不丢', async () => {
    const rows = await readTableFileAsSheet(csvFile('\ufeff企业名,英文名,2026-11-19,2026/11/20,11月21日\n007,alice,白班,休,小夜班3\n'))
    expect(Object.keys(rows[0])).toEqual(['企业名', '英文名', '2026-11-19', '2026/11/20', '11月21日'])
    expect(rows[0]).toMatchObject({ 企业名: '007', '2026-11-19': '白班', '2026/11/20': '休', '11月21日': '小夜班3' })
    const map = inferDateKeys(Object.keys(rows[0]), new Date(2026, 10, 16))
    expect(Object.values(map)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21'])
  })

  it('Excel：日期型表头（默认格式 / 自定义格式）按序列号换算成 YYYY-MM-DD', async () => {
    const f = await xlsxFile([
      { t: 's', v: '英文名' },
      { t: 'n', v: 46345, z: 'm/d/yy' },                     // 默认格式，显示为 11/19/26
      { t: 'n', v: 46346, z: 'm"月"d"日"' },                 // 显示为 11月20日（无年份）
      { t: 'n', v: 46346.9996, z: 'yyyy-mm-dd' }             // 差约 35 秒到午夜：按 11-21 处理
    ])
    const rows = await readTableFileAsSheet(f)
    expect(Object.keys(rows[0])).toEqual(['英文名', '2026-11-19', '2026-11-20', '2026-11-21'])
    expect(rows[0]).toMatchObject({ 英文名: 'alice', '2026-11-19': '白班', '2026-11-20': '休', '2026-11-21': '小夜班3' })
  })

  it('Excel：1904 日期系统也换算正确；普通数字表头不当成日期', async () => {
    const f = await xlsxFile([{ t: 's', v: '英文名' }, { t: 'n', v: 46345 - 1462, z: 'm/d/yy' }, { t: 'n', v: 3 }], true)
    const rows = await readTableFileAsSheet(f)
    expect(Object.keys(rows[0]).sort()).toEqual(['2026-11-19', '3', '英文名'])   // 数字键在对象里会排到最前，不比顺序
  })
})

describe('normalizeScheduleExport（智能排班导出表：两行表头）', () => {
  const TITLE = '班则：最低保障每天白班3人夜班2人'
  const head = { [TITLE]: '企业名', __EMPTY: '英文名', __EMPTY_1: '中文名', '11月21日': '星期六', '11月22日': '星期日' }
  const json = [
    head,
    { [TITLE]: 'corp1', __EMPTY: 'alice', __EMPTY_1: '张一', '11月21日': '白班', '11月22日': '夜班' },
    { [TITLE]: 'corp2', __EMPTY: 'bob', __EMPTY_1: '李二', '11月21日': '夜班', '11月22日': '白班' },
    { [TITLE]: '', __EMPTY: '', __EMPTY_1: '备注', '11月21日': '石冻大年假', '11月22日': '' },
    { [TITLE]: '', __EMPTY: '', __EMPTY_1: '早班1', '11月21日': 2, '11月22日': 1 }
  ]
  const ref = new Date(2026, 10, 18)

  it('还原人员行与 YYYY-MM-DD 日期列，过滤表尾备注 / 统计行', () => {
    const out = normalizeScheduleExport(json, ref)
    expect(out).toHaveLength(2)
    expect(out![0]).toMatchObject({ 企业名: 'corp1', 英文名: 'alice', 中文名: '张一', '2026-11-21': '白班', '2026-11-22': '夜班' })
    expect(out![1]).toMatchObject({ 英文名: 'bob', '2026-11-21': '夜班' })
  })

  it('普通单行表头不会被误判为排班导出表', () => {
    expect(normalizeScheduleExport([{ 企业名: 'corp1', 英文名: 'alice', 中文名: '张一', '2026-11-21': '白班' }], ref)).toBeNull()
  })
})
