// FlowPilot 視窗裡的終端機：每張單一個，執行 `codex resume <對話> --remote unix://`，
// 跟 VS Code 分頁接的是同一段對話，可以直接打字跟 AI 互動。
// 關掉終端機只會結束這個觀看畫面，AI 在常駐服務裡繼續跑。
import * as pty from 'node-pty';

interface Session {
  pty: pty.IPty;
  /** 最近的輸出，畫面重新打開時重播（最多約 200KB） */
  buffer: string;
}

const MAX_BUFFER = 200_000;

export class Terminals {
  private sessions = new Map<number, Session>();

  constructor(
    private readonly send: (channel: string, ...args: unknown[]) => void,
    private readonly log: (message: string) => void,
  ) {}

  /** 打開（已經開著就沿用），回傳目前為止的輸出 */
  open(itemId: number, options: { threadId: string; cwd: string; cols: number; rows: number }): string {
    const existing = this.sessions.get(itemId);
    if (existing) {
      existing.pty.resize(options.cols, options.rows);
      return existing.buffer;
    }
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    const shell = process.env.SHELL || '/bin/zsh';
    const session: Session = {
      // 用登入 shell 執行，才拿得到 codex 的 PATH
      pty: pty.spawn(shell, ['-l', '-c', `exec codex resume '${options.threadId.replace(/'/g, '')}' --remote unix://`], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env,
      }),
      buffer: '',
    };
    session.pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      this.send('term:data', itemId, data);
    });
    session.pty.onExit(({ exitCode }) => {
      this.log(`第 ${itemId} 項的終端機結束（${exitCode}）`);
      this.sessions.delete(itemId);
      this.send('term:exit', itemId, exitCode);
    });
    this.sessions.set(itemId, session);
    return '';
  }

  write(itemId: number, data: string) {
    this.sessions.get(itemId)?.pty.write(data);
  }

  resize(itemId: number, cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.sessions.get(itemId)?.pty.resize(cols, rows);
  }

  close(itemId: number) {
    this.sessions.get(itemId)?.pty.kill();
    this.sessions.delete(itemId);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
