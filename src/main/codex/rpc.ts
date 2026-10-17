// 跟 Codex app-server 溝通的 JSON-RPC 連線（一則訊息一行 JSON）。
// 兩種連法：
// - stdio：自己啟動一個 app-server（AI 判斷這種臨時對話用）
// - daemon：連到本機的共用常駐服務。開發用的對話走這條，VS Code 終端機用 `codex resume --remote` 才接得上同一段對話。
import { t } from '../../shared/i18n';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import WebSocket from 'ws';

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

type Listener = (message: RpcMessage) => void;

export const DAEMON_SOCKET = `${homedir()}/.codex/app-server-control/app-server-control.sock`;

/** 啟動 Codex 用的環境：一定用 ChatGPT 訂閱（拿掉 API 金鑰），補上從 Dock 啟動時缺的 PATH */
export function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  env.PATH = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':');
  return env;
}

/** 確保共用常駐服務在跑（已經在跑就什麼都不做） */
export function ensureDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['app-server', 'daemon', 'start'], { env: codexEnv(), timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(t('無法啟動 Codex 常駐服務：{error}', { error: stderr || error.message })));
      else resolve();
    });
  });
}

export class CodexRpc {
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private nextId = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private starting: Promise<void> | null = null;
  private onDisconnect: (() => void) | null = null;

  constructor(private readonly mode: 'stdio' | 'daemon' = 'stdio') {}

  private alive(): boolean {
    return this.mode === 'stdio' ? !!this.child && this.child.exitCode === null : this.socket?.readyState === WebSocket.OPEN;
  }

  /** 連線並完成初始化；已經連上就直接回傳 */
  start(): Promise<void> {
    if (this.alive()) return Promise.resolve();
    this.starting ??= (this.mode === 'stdio' ? this.spawnStdio() : this.connectDaemon()).then(() => this.initialize()).finally(() => (this.starting = null));
    return this.starting;
  }

  /** 連線中斷時通知（例如常駐服務被關掉），讓上層重新連線、重新訂閱對話 */
  setDisconnectHandler(handler: () => void) {
    this.onDisconnect = handler;
  }

  private async spawnStdio() {
    const child = spawn('codex', ['app-server', '-c', 'features.computer_use=false', '-c', 'features.browser_use=false'], {
      env: codexEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.receive(chunk));
    child.on('exit', () => this.disconnected());
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new Error(t('找不到或無法啟動 Codex：{error}', { error: e.message }))));
    });
  }

  private async connectDaemon() {
    await ensureDaemon();
    const socket = new WebSocket(`ws+unix://${DAEMON_SOCKET}:/`);
    this.socket = socket;
    socket.on('message', (data) => this.receive(`${data.toString()}\n`));
    socket.on('close', () => this.disconnected());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', (e) => reject(new Error(t('連不上 Codex 常駐服務：{error}', { error: e.message }))));
    });
  }

  private async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'flowpilot', title: 'FlowPilot', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: 'initialized' });
  }

  private disconnected() {
    for (const { reject } of this.pending.values()) reject(new Error(t('跟 Codex 的連線中斷了')));
    this.pending.clear();
    this.child = null;
    this.socket = null;
    this.buffer = '';
    this.onDisconnect?.();
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method === undefined && typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        message.error ? reject(new Error(t('Codex 回傳錯誤：{error}', { error: message.error.message }))) : resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  private write(message: RpcMessage) {
    const line = JSON.stringify({ jsonrpc: '2.0', ...message });
    if (this.mode === 'stdio') this.child?.stdin?.write(`${line}\n`);
    else this.socket?.send(line);
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(t('Codex 沒有回應（{method}）', { method })));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ id, method, params });
    });
  }

  /** 回覆 Codex 問我們的事（例如執行同意） */
  reply(id: number | string, result: unknown) {
    this.write({ id, result });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop() {
    this.onDisconnect = null;
    this.child?.kill();
    this.socket?.close();
    this.child = null;
    this.socket = null;
  }
}
