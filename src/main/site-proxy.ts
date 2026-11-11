// 本機網站啟動時清掉瀏覽器存的舊資料（快取、localStorage；設定要的話連 cookie）。
// 做法：網站實際跑在「連接埠 + 10000」，FlowPilot 在原本的連接埠轉一手；每次啟動後第一個打開的頁面，
// 回應裡加上瀏覽器標準的 Clear-Site-Data，Chrome 收到就先清掉這個網址存的資料再顯示頁面。
// 用的還是你平常的 Chrome（擴充功能、「看我的」不受影響），網址也跟以前一樣（後端認得的來源不變）。
// 為什麼要清：同一個連接埠會切 SIT／UAT、換不同的單，舊的登入資料留著會登不進去（實際發生過）。
import http from 'node:http';
import net from 'node:net';

/** 網站實際跑的連接埠 */
export function innerPort(port: number): number {
  return port + 10000;
}

/** 加在 FlowPilot 自己回的錯誤上，用來分辨「網站沒在跑」和「網站回了錯誤」 */
export const PROXY_HEADER = 'x-flowpilot-proxy';

/** 要清哪些：cookie 不分連接埠，清了所有本機網站都會被登出，所以預設不清 */
export function clearSiteDataHeader(cookies: boolean): string {
  return ['"cache"', '"storage"', ...(cookies ? ['"cookies"'] : [])].join(', ');
}

/** 瀏覽器打開頁面的請求（不是圖片、程式檔、API） */
export function isPageRequest(headers: http.IncomingHttpHeaders, method = 'GET'): boolean {
  if (method !== 'GET') return false;
  const dest = headers['sec-fetch-dest'];
  if (dest) return dest === 'document';
  return String(headers.accept ?? '').includes('text/html');
}

export class SiteProxy {
  private servers: http.Server[] = [];
  private sockets = new Set<net.Socket>();
  /** 下一個打開的頁面要清資料 */
  private clearNext = true;
  cookies = false;

  constructor(
    readonly port: number,
    private readonly log: (message: string) => void,
  ) {}

  get listening(): boolean {
    return this.servers.length > 0;
  }

  /** 每次啟動網站時呼叫：下一個打開的頁面清一次 */
  armClear(cookies: boolean) {
    this.clearNext = true;
    this.cookies = cookies;
  }

  /** 在原本的連接埠開始轉送；連接埠被佔用就丟錯 */
  async listen(): Promise<void> {
    if (this.listening) return;
    // localhost 可能解析成 IPv4 或 IPv6，兩個都聽（只聽本機，不對外）
    for (const host of ['127.0.0.1', '::1']) {
      const server = http.createServer((req, res) => this.forward(req, res));
      server.on('upgrade', (req, socket, head) => this.tunnel(req, socket as net.Socket, head));
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(this.port, host, () => resolve());
        });
        this.servers.push(server);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // 這台電腦沒有 IPv6：只聽 IPv4 就好
        if (host === '::1' && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
        this.close();
        throw error;
      }
    }
  }

  close() {
    for (const server of this.servers) server.close();
    for (const socket of this.sockets) socket.destroy();
    this.servers = [];
    this.sockets.clear();
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse) {
    const upstream = http.request(
      { host: 'localhost', port: innerPort(this.port), method: req.method, path: req.url, headers: req.headers, agent: false },
      (up) => {
        const headers: http.OutgoingHttpHeaders = { ...up.headers };
        if (this.clearNext && isPageRequest(req.headers, req.method) && (up.statusCode ?? 0) < 400) {
          this.clearNext = false;
          headers['clear-site-data'] = clearSiteDataHeader(this.cookies);
          this.log(`localhost:${this.port}：網站啟動後第一次打開，清掉瀏覽器存的${this.cookies ? '快取、儲存資料和 cookie' : '快取和儲存資料'}`);
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', [PROXY_HEADER]: '1' });
      res.end('本機網站還沒啟動好（或已經停止）。');
    });
    req.pipe(upstream);
  }

  /** 畫面修改後自動重新整理用的連線（WebSocket）：原封不動接過去 */
  private tunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const up = net.connect({ host: 'localhost', port: innerPort(this.port) }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
  }
}
