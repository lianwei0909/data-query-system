import { describe, it, expect } from 'vitest'
import { parseCSV, decodeText, formatTimeStamp, excelSerialToParts } from '../src/core/text'
import { extractFromStr } from '../src/core/jsonField'
import { APPROVE, REJECT } from '../src/converters'

describe('CSV 与编码', () => {
  it('引号内换行与逗号', () => {
    const r = parseCSV('a,b\n"1,2","x\ny"\n')
    expect(r).toEqual([{ a: '1,2', b: 'x\ny' }])
  })
  it('GBK 解码', () => expect(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文'))
  it('UTF-8 BOM', () => expect(parseCSV('\ufeffa\n1')[0]).toEqual({ a: '1' }))
})

describe('时间格式', () => {
  it('Excel 序列号不偏 8 小时（46191 = 2026-06-18，0.8333 天 ≈ 19:59:57），与 v1 结果一致', () => {
    const p = excelSerialToParts(46191.8333)!
    expect([p.y, p.m, p.d, p.hh, p.mm]).toEqual([2026, 6, 18, 19, 59])
    expect(formatTimeStamp('46191.8333', true)).toBe('2026/6/18 19:59:57')
  })
  it('保留时分秒', () => expect(formatTimeStamp('2026-06-18 9:5:3', true)).toBe('2026/6/18 09:05:03'))
})

describe('JSON 字段提取', () => {
  it('合法 JSON', () => expect(extractFromStr('{"feed_id":"123"}', 'feed_id')).toBe('123'))
  it('双编码 JSON', () => expect(extractFromStr('{\\"feed_id\\":\\"abc\\"}', 'feed_id')).toBe('abc'))
  it('非标准片段', () => expect(extractFromStr('xx "dispute_task_id": 778, "y":1', 'dispute_task_id')).toBe('778'))
})

describe('转换器配置', () => {
  const raw = { TimeStamp: '2026-06-18 10:53:41', operator: 'op1', content_data: '{"feed_id":"f1","dispute_task_id":"t1","evidence_text":"e1"}', answer_data: '{"pruned_desc":"p1"}' }
  it('过审：日期不含时间，取 pruned_desc', () => {
    expect(APPROVE.extract(raw)).toMatchObject({ TimeStamp: '2026/6/18', feed_id: 'f1', dispute_task_id: 't1', evidence_text: 'e1', pruned_desc: 'p1' })
  })
  it('不过审：保留时分秒、带 operator，内容缺失时用 answer_data 兜底', () => {
    const r = REJECT.extract({ ...raw, content_data: '{"feed_id":"f1"}' })
    expect(r).toMatchObject({ TimeStamp: '2026/6/18 10:53:41', operator: 'op1', feed_id: 'f1', evidence_text: 'p1' })
  })
  it('统计口径差异', () => {
    const rows = [APPROVE.extract(raw)]
    expect(APPROVE.stats(rows).find(s => s.error)!.value).toBe(0)
  })
})
