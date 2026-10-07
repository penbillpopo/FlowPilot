// 看板裡的終端機：顯示 `codex resume --remote` 的完整畫面，可以直接打字跟 AI 互動。
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

const api = window.flowpilot;

export function TerminalPanel({ itemId, onClose }: { itemId: number; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: dark ? { background: '#161618' } : { background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', selectionBackground: '#cce0ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();

    let disposed = false;
    const offData = api.terminal.onData((id, data) => id === itemId && term.write(data));
    const offExit = api.terminal.onExit((id) => id === itemId && setExited(true));
    api.terminal
      .open(itemId, term.cols, term.rows)
      .then((history) => {
        if (!disposed && history) term.write(history);
        term.focus();
      })
      .catch((e) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)));
    const input = term.onData((data) => api.terminal.write(itemId, data));
    const observer = new ResizeObserver(() => {
      fit.fit();
      api.terminal.resize(itemId, term.cols, term.rows);
    });
    observer.observe(ref.current!);

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      offData();
      offExit();
      term.dispose();
    };
  }, [itemId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-bar">
        <span className="muted small">終端機：跟 VS Code 分頁接的是同一段對話，可以直接打字。關掉不會停止 AI。</span>
        <button
          className="link"
          onClick={() => {
            api.terminal.close(itemId);
            onClose();
          }}
        >
          關閉終端機
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {exited && <div className="muted small">終端機已結束，關閉後可以重新打開。</div>}
      <div ref={ref} className="terminal-host" />
    </div>
  );
}
