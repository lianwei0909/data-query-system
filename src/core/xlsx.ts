// Excel 解析库按需加载（约 860KB）：只有导入 / 导出 / 转换时才下载
import type * as XLSXNS from 'xlsx-js-style'
type XLSXType = typeof XLSXNS
let promise: Promise<XLSXType> | null = null
export function loadXlsx(): Promise<XLSXType> {
  if (!promise) {
    promise = import('xlsx-js-style').then(m => ((m as unknown as { default?: XLSXType }).default ?? m) as XLSXType)
      .catch(err => { promise = null; throw err })
  }
  return promise
}
