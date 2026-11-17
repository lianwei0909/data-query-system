import { expect, test, type Page } from '@playwright/test'
import { NOW, PEOPLE, contrastOffenders, open, shiftRows, toCsv } from './helpers'

const HIGHS = process.env.E2E_HIGHS === '1'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const seed = (extra: Record<string, string> = {}) => ({ importedShiftData: JSON.stringify(shiftRows()), viewer_name: 'alice', ...extra })

async function blockHighs(page: Page) {
  if (!HIGHS) await page.context().route('**/highs.js', r => r.abort())   // 低内存环境：走备用算法
}
async function runSchedule(page: Page) {
  await page.locator('#btn-run').click()
  await expect(page.locator('#summary-box.active')).toBeVisible({ timeout: 100_000 })
}

test('空数据：统计卡不编造数字，各页面无报错', async ({ page }) => {
  const errors = await open(page)
  await expect(page.locator('.stat-combo').first()).toBeVisible()
  await expect(page.getByText('未导入班表').first()).toBeVisible()
  await expect(page.locator('.attendance-count-num')).toHaveText('--')
  for (const p of ['#/import', '#/scheduler', '#/convert/approve', '#/convert/reject']) {
    await page.goto('./' + p)
    await expect(page.locator('.page-intro h2, .page-intro').first()).toBeVisible()
  }
  expect(errors).toEqual([])
})

test('导入：先核对差异，覆盖明细与实际写入一致，可撤销', async ({ page }) => {
  const errors = await open(page, './#/import')
  const file = page.locator('input[type=file]')
  await file.setInputFiles({ name: '班表.csv', mimeType: 'text/csv', buffer: Buffer.from(toCsv(shiftRows())) })
  await expect(page.locator('.diff-chip').first()).toContainText(`${PEOPLE.length} 名新人员`)
  await page.getByRole('button', { name: /确认导入/ }).click()
  await expect(page.locator('.undo-bar')).toBeVisible()
  const first = await page.evaluate(() => localStorage.getItem('importedShiftData'))

  // 第二份：张一 11-20 改成白班（原为某个班次），并新增 11-21
  const v2 = shiftRows((r, i) => { if (i === 0) { r['2026-11-20'] = r['2026-11-20'] === '白班' ? '休' : '白班'; r['2026-11-21'] = '白班' } })
  await file.setInputFiles({ name: '班表2.csv', mimeType: 'text/csv', buffer: Buffer.from(toCsv(v2)) })
  await expect(page.locator('.diff-chip.warn')).toContainText('1 格覆盖已有班次')
  await expect(page.locator('.diff-table tbody tr')).toHaveCount(1)
  await expect(page.locator('.diff-table tbody tr td').nth(1)).toHaveText('张一（alice）')
  await expect(page.getByRole('button', { name: '✅ 确认导入（覆盖 1 格）' })).toBeVisible()
  await page.getByRole('button', { name: /确认导入/ }).click()
  const merged = await page.evaluate(() => JSON.parse(localStorage.getItem('importedShiftData')!))
  expect(merged[0]['2026-11-20']).toBe(v2[0]['2026-11-20'])
  expect(merged[0]['2026-11-21']).toBe('白班')

  await page.getByRole('button', { name: /撤销本次导入/ }).click()
  await expect(page.locator('.undo-bar')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('importedShiftData'))).toBe(first)
  expect(errors).toEqual([])
})

test('日历：按查看人显示班次与统计', async ({ page }) => {
  const errors = await open(page, './', seed())
  await expect(page.locator('#calendar .cal-shift:not(.s-none)').first()).toBeVisible()
  expect(await page.locator('#calendar .cal-shift:not(.s-none)').count()).toBeGreaterThanOrEqual(20)
  await expect(page.locator('.attendance-count-num')).not.toHaveText('--')
  expect(errors).toEqual([])
})

test('便签：v1 数据迁移到 IndexedDB，粘贴图片后刷新仍保留', async ({ page }) => {
  const errors = await open(page, './', { board_memo: 'v1 便签', board_collapsed: '0', board_images: JSON.stringify([{ src: PNG, x: 20, y: 30, w: 120 }]) })
  await expect(page.locator('.board-img')).toHaveCount(1)
  await expect(page.locator('#board-memo')).toHaveValue('v1 便签')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('board_images'))).toBeNull()
  await page.evaluate(async png => {
    const b = await (await fetch(png)).blob()
    const dt = new DataTransfer(); dt.items.add(new File([b], 'a.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  }, PNG)
  await expect(page.locator('.board-img')).toHaveCount(2)
  await page.waitForTimeout(300)
  await page.reload()
  await expect(page.locator('.board-img')).toHaveCount(2)
  await expect(page.locator('#board-preview')).toContainText('2 张图片')
  expect(errors).toEqual([])
})

test('排班：生成、校验报告、导出 Excel', async ({ page }) => {
  await blockHighs(page)
  const errors = await open(page, './?solverLimit=5#/scheduler', seed())
  await expect(page.locator('#people-box tbody tr')).toHaveCount(PEOPLE.length + 1)
  await expect(page.locator('#period-label')).toContainText('2026年11月21日 ~ 2026年12月20日')
  await page.locator('#people-box tbody tr').first().locator('input[type=text]').fill('11月25日-26日年假')
  await runSchedule(page)
  await expect(page.locator('#result-box .sch-table tbody tr')).toHaveCount(PEOPLE.length)
  const row1 = page.locator('#result-box .sch-table tbody tr').first().locator('td')
  await expect(row1.nth(5)).toHaveText('年假')
  await expect(page.locator('#summary-box')).toContainText(HIGHS ? '精确求解用时' : '精确求解不可用')
  await expect(page.locator('#summary-box')).toContainText('已按「数据导入」的实际班表衔接上期')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export').click()])
  expect(dl.suggestedFilename()).toBe('排班_2026-11-21_12-20.xlsx')
  expect(errors).toEqual([])
})

for (const theme of ['aurora', 'paper'] as const) {
  test(`对比度（${theme === 'paper' ? '亮色' : '暗色'}主题）：日历、导入核对、排班结果文字 ≥ WCAG AA`, async ({ page }) => {
    await blockHighs(page)
    await open(page, './', seed({ ui_theme: theme }))
    const TEXT = 'body *'
    expect(await contrastOffenders(page, TEXT)).toEqual([])
    await page.goto('./#/import')
    await page.locator('input[type=file]').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(toCsv(shiftRows((r, i) => { if (i < 2) r['2026-11-20'] = '年假' }))) })
    await expect(page.locator('.diff-chip.warn')).toBeVisible()
    expect(await contrastOffenders(page, TEXT)).toEqual([])
    await page.goto('./#/scheduler')
    await runSchedule(page)
    // 违规提示、标红格子用固定样例检查样式（是否真的违规取决于求解结果，不适合做断言前提）
    await page.evaluate(() => {
      document.querySelector('#summary-box')!.insertAdjacentHTML('afterbegin', '<div class="sch-violations"><div class="sch-violation">⚠ 样例：12月1日 白班仅 2 人</div></div>')
      document.querySelector('#result-box .sch-cell.stat')?.classList.add('bad')
    })
    await expect(page.locator('.sch-violation').first()).toBeVisible()
    expect(await contrastOffenders(page, TEXT)).toEqual([])
    await page.screenshot({ path: `test-results/contrast-${theme}.png`, fullPage: true })
  })
}

test.describe('移动端（390px 触屏）', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('无横向溢出，日历翻页按钮 ≥ 44px', async ({ page }) => {
    const errors = await open(page, './', seed())
    for (const p of ['./', './#/import', './#/scheduler']) {
      await page.goto(p)
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), p).toBeLessThanOrEqual(1)
    }
    await page.goto('./')
    const box = await page.locator('.cal-nav-btn').first().boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(errors).toEqual([])
  })
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: `test-results/fail-${info.title.slice(0, 20)}.png`, fullPage: true }).catch(() => {})
})
void NOW
