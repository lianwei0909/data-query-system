// 中国法定节假日（国务院办公厅每年公布）。off = 放假日；work = 周末调休补班日；格式 'M-D'。
// 每年公布次年安排后在这里加一个年份；未配置的年份按「周六日休息」推算，并在界面上标注。
export interface HolidayYear { off: string[]; work: string[] }

export const CN_HOLIDAYS: Record<number, HolidayYear> = {
  2026: {
    off: ['1-1', '1-2', '1-3', '2-15', '2-16', '2-17', '2-18', '2-19', '2-20', '2-21', '2-22', '2-23', '4-4', '4-5', '4-6',
      '5-1', '5-2', '5-3', '5-4', '5-5', '6-19', '6-20', '6-21', '9-25', '9-26', '9-27', '10-1', '10-2', '10-3', '10-4',
      '10-5', '10-6', '10-7'],
    work: ['1-4', '2-14', '2-28', '5-9', '9-20', '10-10']
  },
  // 国办发明电〔2026〕10号（2026-11-05）https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm
  2027: {
    off: ['1-1', '1-2', '1-3', '2-5', '2-6', '2-7', '2-8', '2-9', '2-10', '2-11', '2-12', '2-13', '4-3', '4-4', '4-5', '5-1',
      '5-2', '5-3', '5-4', '5-5', '6-9', '9-15', '10-1', '10-2', '10-3', '10-4', '10-5', '10-6', '10-7'],
    work: ['1-31', '2-14', '5-8', '9-26', '10-9']
  }
  // 2028: { off: [...], work: [...] }   ← 待国务院办公厅公布后补充
}

export const holidayYear = (y: number): HolidayYear | null => CN_HOLIDAYS[y] ?? null

export function isWorkday(d: Date, table: Record<number, HolidayYear> = CN_HOLIDAYS): boolean {
  const h = table[d.getFullYear()]
  const key = `${d.getMonth() + 1}-${d.getDate()}`
  const dow = d.getDay()
  if (h) {
    if (h.off.includes(key)) return false
    if (dow === 0 || dow === 6) return h.work.includes(key)
    return true
  }
  return !(dow === 0 || dow === 6)
}

/** 发薪日：每月 5 号，遇周末 / 法定节假日提前到之前最近的工作日；本月发薪日已过（含提前发薪）则取下月 */
export function nextPayday(today: Date, payDay = 5): Date {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  for (let k = 0; k < 3; k++) {
    let p = new Date(t0.getFullYear(), t0.getMonth() + k, payDay)
    for (let back = 0; back < 25 && !isWorkday(p); back++) p = new Date(p.getFullYear(), p.getMonth(), p.getDate() - 1)
    if (p.getTime() >= t0.getTime()) return p
  }
  return new Date(t0.getFullYear(), t0.getMonth() + 1, payDay)
}
