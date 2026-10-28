// FlowPilot 測試瀏覽器的寫入防護（交給 Playwright MCP 的 --init-page 執行，每開一個分頁就套用一次）。
// 會改資料的請求一律擋下：記下送出的內容，回一個假的成功；這樣 AI 可以按「儲存」驗證 payload，資料又不會寫進 SIT。
// 規則：GET 這類只讀的放行；登入相關放行；網址最後一段有「新增、修改、刪除…」的字就擋；有「查詢」的字放行；看不出來的擋下。
const fs = require('fs');

const LOGIN = /(login|logout|signin|signout|captcha|otp|token)/i;
const WRITE = /(add|create|insert|update|edit|modify|save|delete|remove|del|set|submit|approve|reject|cancel|enable|disable|import|transfer|bind|reset|change|audit|confirm|send|apply|batch|sync|withdraw|deposit|pay|refund|freeze|lock|recharge|adjust|grant|revoke|publish|close|open|move|copy|sort)/i;
const READ = /(list|search|query|get|detail|info|page|count|summary|export|check|find|options|select|tree|report|stat|label|menu|lobby|banner|notice|balance|history|record|version|config)/i;
// 登入流程的其他步驟（寄驗證信、驗證兩步驟碼…）：網址在 /auth/ 底下才算；改密碼、綁定、註冊這類還是擋
const AUTH_STEP = /(verify|2fa|mfa|otp|captcha|code|refresh)/i;
const AUTH_CHANGE = /(password|pwd|bind|register|signup|unbind)/i;

function decide(method, url) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'pass';
  let last = '';
  let path = '';
  try {
    path = new URL(url).pathname;
    last = path.split('/').filter(Boolean).pop() || '';
  } catch {}
  if (LOGIN.test(last) && !WRITE.test(last.replace(LOGIN, ''))) return 'login';
  // 實際發生過：PlatformWeb 登入後要寄驗證信（sendemailverify）、驗證兩步驟碼（verify2fa），被當成寫入擋下回假成功，拿不到登入憑證就被登出
  if (/\/auth\//i.test(path) && AUTH_STEP.test(last) && !AUTH_CHANGE.test(last)) return 'login';
  // 上傳檔案（例如 Banner 圖片）放行：只是傳到檔案伺服器，不會改到業務資料；擋下的話表單拿不到圖片網址，存檔流程測不完
  if (method === 'POST' && /upload/i.test(last)) return 'upload';
  // PUT、PATCH、DELETE 本身就是改資料，一律擋；只有 POST 可能是查詢
  if (method !== 'POST') return 'block';
  if (WRITE.test(last)) return 'block';
  if (READ.test(last)) return 'read';
  return 'block';
}

function recordEntry(entry) {
  const file = process.env.FLOWPILOT_REQUEST_LOG;
  if (!file) return;
  try {
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

/** 只記錄送到專案後端的請求（FlowPilot 從 environment.ts 讀出 SIT、UAT 的後端主機）；其他網站的寫入照樣擋下，但不記，免得紀錄被塞滿 */
function shouldRecord(url) {
  const hosts = (process.env.FLOWPILOT_API_HOSTS || '').split(',').filter(Boolean);
  if (!hosts.length) return true;
  try {
    return hosts.includes(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * 假資料：FlowPilot 存在「假資料/<單的編號>.json」（從請求紀錄的路徑推出來，所以每個請求都重讀，改了馬上生效）。
 * 比對規則跟 src/shared/mocks.ts 一樣（這個檔案是給 Playwright 直接執行的，不能 import TypeScript）
 */
function readMocks() {
  const log = process.env.FLOWPILOT_REQUEST_LOG;
  if (!log) return null;
  const path = require('path');
  const file = path.join(path.dirname(path.dirname(log)), '假資料', path.basename(log).replace(/\.jsonl$/, '.json'));
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pathMatches(pattern, pathname) {
  const re = new RegExp('^' + String(pattern).trim().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '/?$', 'i');
  return re.test(pathname);
}

function findMock(set, method, url) {
  if (!set || !set.enabled) return null;
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  return (set.rules || []).find((r) => r.on && (!r.method || r.method.toUpperCase() === method.toUpperCase()) && pathMatches(r.path, pathname)) || null;
}

module.exports.findMock = findMock;
module.exports.decide = decide;
module.exports.shouldRecord = shouldRecord;
module.exports.default = async ({ page }) => {
  // 有開假資料：畫面角落標「假資料模式」，避免看錯
  if (readMocks()?.enabled) {
    await page.addInitScript(() => {
      const show = () => {
        if (document.getElementById('flowpilot-mock-badge')) return;
        const el = document.createElement('div');
        el.id = 'flowpilot-mock-badge';
        el.textContent = 'FlowPilot 假資料模式';
        el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#d97706;color:#fff;font:600 12px sans-serif;padding:4px 10px;border-radius:12px;pointer-events:none;opacity:.9';
        document.documentElement.appendChild(el);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
      else show();
    });
  }
  await page.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    // 假資料優先：對到的 API 直接回準備好的內容，不送到後端
    const mocks = readMocks();
    const headers = request.headers();
    // 跨網域：假資料要帶允許的標頭；預檢（OPTIONS）也直接回好，不送到還沒有這支 API 的後端
    const cors = {
      'access-control-allow-origin': headers.origin || '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': headers['access-control-request-headers'] || '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    };
    if (method === 'OPTIONS' && findMock(mocks, headers['access-control-request-method'] || 'GET', request.url())) {
      return route.fulfill({ status: 204, headers: cors });
    }
    const mock = findMock(mocks, method, request.url());
    if (mock) {
      recordEntry({ action: '假資料（沒有送到後端）', method, url: request.url() });
      return route.fulfill({ status: Number(mock.status) || 200, contentType: 'application/json', headers: cors, body: mock.body || '{}' });
    }
    const action = decide(method, request.url());
    if (action === 'pass') return route.continue();
    const record = shouldRecord(request.url()) ? recordEntry : () => {};
    let body = request.postData() || '';
    try {
      body = JSON.parse(body);
    } catch {}
    if (action === 'login') {
      record({ action: '放行（登入）', method, url: request.url() }); // 登入的內容有密碼，不記
      return route.continue();
    }
    if (action === 'upload') {
      record({ action: '放行（上傳檔案）', method, url: request.url() });
      return route.continue();
    }
    if (action === 'read') {
      record({ action: '放行（查詢）', method, url: request.url(), body });
      return route.continue();
    }
    record({ action: '擋下（沒有送到後端）', method, url: request.url(), body });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, success: true, data: null, message: 'FlowPilot 擋下了這個寫入請求（假的成功，資料沒有寫入）' }),
    });
  });
};
