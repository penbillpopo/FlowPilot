import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSiteDataHeader, innerPort, PROXY_HEADER, SiteProxy } from '../src/main/site-proxy';

// 每個測試用不同的連接埠（fetch 會沿用舊連線，同一個連接埠關掉再開會連到已經斷的連線）
let PORT = 20000 + Math.floor(Math.random() * 20000);
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  PORT += 7;
});

/** 假的網站：跑在 innerPort；WebSocket 連線收到什麼就回什麼 */
async function fakeSite() {
  const server = http.createServer((req, res) => res.end(`page ${req.url} host=${req.headers.host}`));
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise<void>((r) => server.listen(innerPort(PORT), '127.0.0.1', () => r()));
  closers.push(() => { server.closeAllConnections(); server.close(); });
}

const page = (path = '/') => fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } });

describe('啟動網站時清瀏覽器資料', () => {
  it('啟動後第一個打開的頁面清一次；圖片、程式檔不清；再啟動又清一次', async () => {
    await fakeSite();
    const proxy = new SiteProxy(PORT, () => {});
    closers.push(() => proxy.close());
    await proxy.listen();
    const asset = await fetch(`http://127.0.0.1:${PORT}/main.js`, { headers: { 'sec-fetch-dest': 'script' } });
    expect(asset.headers.get('clear-site-data')).toBeNull();
    const first = await page();
    expect(first.headers.get('clear-site-data')).toBe('"cache", "storage"');
    // 網址、Host 照原本的轉過去
    expect(await first.text()).toBe(`page / host=127.0.0.1:${PORT}`);
    expect((await page('/login')).headers.get('clear-site-data')).toBeNull();
    proxy.armClear(true);
    expect((await page()).headers.get('clear-site-data')).toBe('"cache", "storage", "cookies"');
  });

  it('網站還沒起來：回 502 並標明是 FlowPilot 回的（自動測試不會誤以為網站好了）；之後起來第一頁照樣清', async () => {
    const proxy = new SiteProxy(PORT, () => {});
    closers.push(() => proxy.close());
    await proxy.listen();
    const down = await page();
    expect(down.status).toBe(502);
    expect(down.headers.get(PROXY_HEADER)).toBe('1');
    await fakeSite();
    expect((await page()).headers.get('clear-site-data')).toBe(clearSiteDataHeader(false));
  });

  it('畫面自動重新整理的連線（WebSocket）原封不動接過去', async () => {
    await fakeSite();
    const proxy = new SiteProxy(PORT, () => {});
    closers.push(() => proxy.close());
    await proxy.listen();
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(PORT, '127.0.0.1', () => {
        socket.write(`GET /ws HTTP/1.1\r\nHost: localhost:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
      });
      let got = '';
      socket.on('data', (d) => {
        got += d.toString();
        if (got.includes('\r\n\r\n') && !got.includes('ping')) socket.write('ping');
        if (got.includes('ping')) {
          socket.destroy();
          resolve(got);
        }
      });
      socket.on('error', reject);
    });
    expect(reply).toContain('101 Switching Protocols');
    expect(reply).toContain('ping');
  });

  it('連接埠被佔用：丟錯，讓畫面說清楚', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(PORT, '127.0.0.1', () => r()));
    closers.push(() => blocker.close());
    const proxy = new SiteProxy(PORT, () => {});
    await expect(proxy.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(proxy.listening).toBe(false);
  });
});
