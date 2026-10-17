// 跑版檢查：連到開著的 FlowPilot（用除錯模式開：open -a FlowPilot --args --remote-debugging-port=9333），
// 逐一切換畫面（作戰室的三個分頁、更多選單、齒輪選單、已完成的單、任務簡報、勾兩張單、Jira 狀態選單、計畫表、發 PR 表單），
// 在每個畫面跑 detect.js 找跑版（文字超出框、被蓋住、重疊、按鈕換行、詞被拆開、英文黏在一起、橫向捲軸），並截圖。
// 只切換、打開來看，不按會執行動作的按鈕，也不會啟動 AI。
//
// 用法：PW=<playwright-core 的路徑> node scripts/layout-check/check.cjs <截圖資料夾> 1510x860,1280x780,1100x720
//       中文介面加 ZH=1（畫面要先切成中文）；要先試樣式加 CSS=<檔案>
const { chromium } = require(process.env.PW);
const fs = require('fs');
const detect = fs.readFileSync(__dirname + '/detect.js', 'utf8');
const css = process.env.CSS && fs.existsSync(process.env.CSS) ? fs.readFileSync(process.env.CSS, 'utf8') : ''; // 先試的樣式（還沒改進程式碼前，直接套在畫面上驗證）
const T = process.env.ZH ? { war: '作戰室', brief: '任務簡報', tabs: ['改動', '驗收', '本機網站'], more: /^更多$/, back: /^返回/, pr: /^用 Azure (再)?發/, cancel: /^取消/ } : { war: 'War Room', brief: 'Mission Briefing', tabs: ['Changes', 'Acceptance', 'Local Site'], more: /^More$/, back: /^Back/, pr: /^Create PR in Azure|^Create another PR/, cancel: /^Cancel/ };
const out = process.argv[2]; const widths = (process.argv[3] || '1510x860').split(',');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = browser.contexts()[0].pages()[0];
  if (css) await page.evaluate((c) => { let s = document.getElementById('fix-css'); if (!s) { s = document.createElement('style'); s.id = 'fix-css'; document.head.appendChild(s); } s.textContent = c; }, css);
  const report = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${name}.png` });
    const p = await page.evaluate(detect);
    console.log(`== ${name}：${p.length} 個`); for (const [k, d] of p) console.log(`  [${k}] ${d}`);
  };
  const tab = async (text) => { const el = page.getByText(text, { exact: true }).first(); if (await el.count()) await el.click(); };
  for (const size of widths) {
    const [w, h] = size.split('x').map(Number);
    await page.setViewportSize({ width: w, height: h });
    await tab(T.war); await page.waitForTimeout(1500);
    await page.locator('aside li').first().click();
    for (const t of T.tabs) { const el = page.locator('.right-tabs button', { hasText: t }).first(); if (await el.count()) { await el.click(); await report(`${w}-a-${t.replace(' ', '')}`); } }
    const more = page.locator('.head-actions summary, .head-actions button', { hasText: T.more }).first();
    if (await more.count()) { await more.click(); await report(`${w}-b-more`); await more.click(); }
    for (let i = 0; i < 3; i++) { await page.locator('aside li').nth(i).click(); const m = page.locator('.head-actions summary, .head-actions button', { hasText: T.more }).first(); if (await m.count()) { await m.click(); await report(`${w}-b-more${i}`); await m.click(); } }
    await page.locator('.skin-menu summary').click(); await report(`${w}-c-gear`); await page.locator('.skin-menu summary').click();
    const items = page.locator('aside li'); const n = await items.count();
    for (let i = 1; i < Math.min(n, 4); i++) { await items.nth(i).click(); await report(`${w}-d-item${i}`); }
    await tab(T.brief); await page.waitForTimeout(2500); await report(`${w}-e-tickets`);
    // 勾兩張單看按鈕文字，再取消勾選
    const boxes = page.locator('tbody input[type=checkbox]:not([disabled])');
    if (await boxes.count() >= 2) { await boxes.nth(0).check(); await boxes.nth(1).check(); await report(`${w}-f-two-selected`); await boxes.nth(0).uncheck(); await boxes.nth(1).uncheck(); }
    // Jira 狀態下拉（只讀可以切到哪些狀態，不切換）
    const chip = page.locator('td.state button.status:not([disabled])').first();
    if (await chip.count()) { await chip.click(); await page.waitForTimeout(2500); await report(`${w}-g-status-menu`); await page.keyboard.press('Escape'); await page.mouse.click(200, 120); await page.waitForTimeout(300); }
    // 計畫表（點計畫中的那張單打開，只看不按）
    const planning = page.locator('tr.planning').first();
    if (await planning.count()) { await planning.click(); await page.waitForTimeout(1500); await report(`${w}-h-plan`);
      await page.evaluate(() => { const s = [...document.querySelectorAll('*')].find((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 50); if (s) s.scrollTop = s.scrollHeight; }); await report(`${w}-h-plan-bottom`);
      const back = page.getByRole('button', { name: T.back }).first(); if (await back.count()) await back.click(); await page.waitForTimeout(800); }
    // 已完成的單：打開發 PR 表單（只讀 Azure 的分支、審核人，不會發）
    await tab(T.war); await page.waitForTimeout(1500);
    await page.locator('aside li').nth(1).click(); await page.waitForTimeout(800);
    const pr = page.getByRole('button', { name: T.pr }).first();
    if (await pr.count()) { await pr.click(); await page.waitForTimeout(5000); await report(`${w}-i-pr-form`); const cancel = page.locator('.pr-panel').getByRole('button', { name: T.cancel }).first(); if (await cancel.count()) await cancel.click(); }
    await tab(T.war); await page.waitForTimeout(1500);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
