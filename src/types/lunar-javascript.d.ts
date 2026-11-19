declare module 'lunar-javascript' {
  export interface LunarDay {
    getMonthInChinese(): string
    getDayInChinese(): string
    getJieQi(): string
    getFestivals(): string[]
  }
  export interface SolarDay {
    getFestivals(): string[]
    getLunar(): LunarDay
  }
  export const Solar: {
    fromYmd(y: number, m: number, d: number): SolarDay
  }
}
