// 日历小字：节气 / 节日优先，其次农历日（廿三、初一等）。
// 数据源 lunar-javascript（MIT）：农历、节气、公历/农历节日；另外补「宪法日」并把「元旦节」规范成「元旦」。
import { Solar } from 'lunar-javascript'

const EXTRA_SOLAR: Record<string, string> = { '12-4': '宪法日' }
const RENAME: Record<string, string> = { 元旦节: '元旦' }

export interface LunarLabel { text: string; kind: 'festival' | 'lunar' }

export function lunarLabel(y: number, m: number, d: number): LunarLabel {
  const solar = Solar.fromYmd(y, m, d)
  const lunar = solar.getLunar()
  const festival = (lunar.getJieQi() || solar.getFestivals()[0] || lunar.getFestivals()[0] || EXTRA_SOLAR[`${m}-${d}`] || '')
  if (festival) return { text: RENAME[festival] || festival, kind: 'festival' }
  // 日历格子小字只放农历日（初一 / 廿三 / 十一），与系统日历一致；月份靠公历日期即可辨认
  return { text: lunar.getDayInChinese(), kind: 'lunar' }
}
