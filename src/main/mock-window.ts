// 你手動測用的假資料視窗：FlowPilot 自己開一個瀏覽器視窗打開本機網站，指定的 API 回假資料、其他請求照常送到後端。
// 不改專案程式碼。用獨立的瀏覽器資料（登入一次會記住），跟 FlowPilot 本身的畫面分開。
import { BrowserWindow, net, session } from 'electron';
import { t } from '../shared/i18n';
import { findMock, type MockSet } from '../shared/mocks';

const PARTITION = 'persist:flowpilot-mock';
let handled = false;
/** 目前視窗用的是哪一張單的假資料（每個請求都重讀，改了馬上生效） */
let current: (() => MockSet) | null = null;

function intercept() {
  if (handled) return;
  handled = true;
  const ses = session.fromPartition(PARTITION);
  for (const scheme of ['http', 'https']) {
    ses.protocol.handle(scheme, async (request) => {
      const set = current?.() ?? null;
      // 跨網域：假資料的回應要帶允許的標頭；瀏覽器先送的預檢（OPTIONS）也直接回好，不送到還沒有這支 API 的後端
      const cors = {
        'access-control-allow-origin': request.headers.get('origin') || '*',
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      };
      if (request.method === 'OPTIONS' && findMock(set, request.headers.get('access-control-request-method') || 'GET', request.url)) {
        return new Response(null, { status: 204, headers: cors });
      }
      const mock = findMock(set, request.method, request.url);
      if (mock) {
        return new Response(mock.body || '{}', { status: Number(mock.status) || 200, headers: { 'content-type': 'application/json', ...cors } });
      }
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    });
  }
}

/** 角落的「假資料模式」標籤，避免看錯 */
const BADGE = `(() => {
  if (document.getElementById('flowpilot-mock-badge')) return;
  const el = document.createElement('div');
  el.id = 'flowpilot-mock-badge';
  el.textContent = 'FlowPilot 假資料模式';
  el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#d97706;color:#fff;font:600 12px sans-serif;padding:4px 10px;border-radius:12px;pointer-events:none;opacity:.9';
  document.documentElement.appendChild(el);
})()`;

let win: BrowserWindow | null = null;

export async function openMockWindow(url: string, title: string, mocks: () => MockSet) {
  current = mocks;
  intercept();
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({ width: 1280, height: 860, title, webPreferences: { partition: PARTITION } });
    win.webContents.on('did-finish-load', () => void win?.webContents.executeJavaScript(BADGE).catch(() => {}));
    win.on('closed', () => (win = null));
  }
  win.setTitle(t('{title}（假資料模式）', { title }));
  await win.loadURL(url);
  win.focus();
}
