// 資料夾終端機：每個資料夾一個互動式 shell（跟 VS Code 下方的終端機一樣，可以輸入任何指令）。
// 「在本機啟動」會在這裡輸入啟動指令；從輸出抓到本機網址時通知畫面，顯示「打開網頁」。
import { t } from '../shared/i18n';
import * as pty from 'node-pty';

const MAX_BUFFER = 300_000;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?[^\s'"\x1b]*/;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

interface Session {
  pty: pty.IPty;
  /** 取消監聽（結束 FlowPilot 時先取消，再關終端機） */
  listeners: { dispose(): void }[];
  buffer: string;
  url: string | null;
}

export class FolderTerminals {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly send: (channel: string, ...args: unknown[]) => void,
    private readonly log: (message: string) => void,
  ) {}

  /** 打開（已經開著就沿用），回傳目前為止的輸出與抓到的網址 */
  open(folder: string, cwd: string, cols: number, rows: number): { buffer: string; url: string | null } {
    const existing = this.sessions.get(folder);
    if (existing) {
      existing.pty.resize(Math.max(cols, 20), Math.max(rows, 5));
      return { buffer: existing.buffer, url: existing.url };
    }
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const session: Session = {
      // 互動式的登入 shell：拿得到你平常的 PATH、nvm、別名
      pty: pty.spawn(process.env.SHELL || '/bin/zsh', ['-l'], { name: 'xterm-256color', cols: Math.max(cols, 20), rows: Math.max(rows, 5), cwd, env }),
      buffer: '',
      url: null,
      listeners: [],
    };
    const onData = session.pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      this.send('folderTerm:data', folder, data);
      const found = stripAnsi(data).match(URL_PATTERN)?.[0]?.replace('0.0.0.0', 'localhost');
      if (found && found !== session.url) {
        session.url = found;
        this.send('folderTerm:url', folder, found);
      }
    });
    const onExit = session.pty.onExit(({ exitCode }) => {
      this.log(`${folder} 的終端機結束（${exitCode}）`);
      this.sessions.delete(folder);
      this.send('folderTerm:exit', folder);
    });
    session.listeners.push(onData, onExit);
    this.sessions.set(folder, session);
    return { buffer: '', url: null };
  }

  write(folder: string, data: string) {
    this.sessions.get(folder)?.pty.write(data);
  }

  resize(folder: string, cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.sessions.get(folder)?.pty.resize(cols, rows);
  }

  /** 在終端機裡輸入並執行一行指令（例如啟動本機網站） */
  run(folder: string, command: string) {
    const session = this.sessions.get(folder);
    if (!session) throw new Error(t('終端機還沒打開'));
    session.url = null;
    this.send('folderTerm:url', folder, null);
    session.pty.write(`${command}\r`);
  }

  /**
   * 確保本機網站有在跑，回傳網址：連接埠已經連得上就直接用（不管是誰啟動的）；
   * 否則在這個資料夾的終端機輸入啟動指令，等到連得上為止。
   */
  async ensureSite(folder: string, cwd: string, command: string, port: number, timeoutMs = 6 * 60_000): Promise<string> {
    const url = `http://localhost:${port}/`;
    if (await reachable(url)) return url;
    if (!this.sessions.has(folder)) this.open(folder, cwd, 120, 30);
    this.run(folder, command);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!this.sessions.has(folder)) throw new Error(t('終端機結束了，網站沒有啟動成功'));
      if (await reachable(url)) return url;
    }
    throw new Error(t('等了 {minutes} 分鐘，{url} 還是連不上，請看右邊的終端機', { minutes: Math.round(timeoutMs / 60_000), url }));
  }

  /** 等於按 Ctrl+C，停止正在跑的指令 */
  interrupt(folder: string) {
    const session = this.sessions.get(folder);
    if (!session) return;
    session.pty.write('\x03');
    session.url = null;
    this.send('folderTerm:url', folder, null);
  }

  /**
   * 結束 FlowPilot 時關掉所有終端機：先取消監聽再關。
   * 不然終端機在 FlowPilot 關閉途中回報「結束了」，會讓整個程式當掉（實際發生過）。
   */
  /** 整個關掉某個終端機（連同在裡面跑的網站）；分析報告截改動前畫面時開的臨時網站用 */
  close(folder: string) {
    const session = this.sessions.get(folder);
    if (!session) return;
    for (const listener of session.listeners) listener.dispose();
    session.pty.kill();
    this.sessions.delete(folder);
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      for (const listener of session.listeners) listener.dispose();
      session.pty.kill();
    }
    this.sessions.clear();
  }
}
