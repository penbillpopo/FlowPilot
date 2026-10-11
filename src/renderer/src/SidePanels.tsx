// 工作台右邊：測試（SIT／UAT、測試帳號）、資料夾終端機（啟動本機網站、自己下指令）與 Git 改動（像 VS Code 的原始碼控制）
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { Env, GitFile, GitState, TestState, WorkItem } from '../../shared/types';
import { errorText } from './ChatPanel';
import { DiffView } from './DiffView';

const api = window.flowpilot;

/**
 * 測試：資料夾目前連 SIT 還是 UAT（只切換 environment.ts 的註解）、這次測試會用哪個帳號。
 * 指定的帳號只限這張單，沒指定就用帳號檔（~/.codex/local-test-configs）。畫面上只顯示帳號，不顯示密碼。
 */
export function TestPanel({ item }: { item: WorkItem }) {
  const [state, setState] = useState<TestState | null>(null);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setEditing(false);
    setError(null);
    const refresh = () => api.test.state(item.id).then(setState).catch((e) => setError(errorText(e)));
    refresh();
    // 你也可能在別的地方改了 environment.ts
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [item.id, item.folder]);

  async function act(action: () => Promise<TestState>) {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!item.folder) return null;
  const env = state?.environment;

  return (
    <div className="panel test-panel">
      <div className="panel-head">
        <strong>測試</strong>
        <span className="muted small">本機連的環境與登入帳號</span>
      </div>
      <div className="test-row">
        <span className="test-label">環境</span>
        <div className="segmented">
          {(['sit', 'uat'] as Env[]).map((e) => (
            <button key={e} className={env === e ? 'on' : ''} disabled={busy || env === e || env === null} onClick={() => act(() => api.test.setEnvironment(item.id, e))}>
              {e.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {env === 'mixed' && <p className="warn small">environment.ts 的 SIT、UAT 兩組都開著或都註解掉了，選一個就會整理好。</p>}
      {env === null && state && <p className="muted small">environment.ts 裡找不到 SIT／UAT 的標記，沒辦法切換。</p>}
      <div className="test-row">
        <span className="test-label">帳號</span>
        {state?.account ? (
          <span>
            {state.account.username} <span className="muted small">（{state.account.source}）</span>
          </span>
        ) : (
          <span className="warn small">{env === 'sit' || env === 'uat' ? `帳號檔裡沒有 ${env.toUpperCase()} 的帳號，請指定` : '—'}</span>
        )}
      </div>
      {!editing && (
        <div className="row">
          <button className="link" onClick={() => { setUsername(state?.override ?? ''); setPassword(''); setEditing(true); }}>
            {state?.override ? '改這張單的帳號' : '這張單改用別的帳號'}
          </button>
          {state?.override && (
            <button className="link" disabled={busy} onClick={() => act(() => api.test.setAccount(item.id, null))}>
              改回用帳號檔
            </button>
          )}
        </div>
      )}
      {editing && (
        <form
          className="account-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(() => api.test.setAccount(item.id, { username, password }))) {
              setEditing(false);
              setPassword('');
            }
          }}
        >
          <input placeholder="帳號" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          <input placeholder="密碼" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !username.trim() || !password}>只用在這張單</button>
            <button type="button" onClick={() => setEditing(false)}>取消</button>
          </div>
        </form>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/** 資料夾終端機：固定顯示、可以直接輸入；「在本機啟動」會在這裡執行啟動指令，抓到網址後可以打開網頁 */
export function FolderTerminalPanel({ item }: { item: WorkItem }) {
  const host = useRef<HTMLDivElement>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    if (!item.folder) return;
    setError(null);
    setExited(false);
    setUrl(null);
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
    term.open(host.current!);
    fit.fit();
    let current: string | null = null;
    const offData = api.folderTerminal.onData((f, data) => f === current && term.write(data));
    const offUrl = api.folderTerminal.onUrl((f, u) => f === current && setUrl(u));
    const offExit = api.folderTerminal.onExit((f) => f === current && setExited(true));
    api.folderTerminal
      .open(item.id, term.cols, term.rows)
      .then((opened) => {
        current = opened.folder;
        setFolder(opened.folder);
        setUrl(opened.url);
        if (opened.buffer) term.write(opened.buffer);
      })
      .catch((e) => setError(errorText(e)));
    const input = term.onData((data) => current && api.folderTerminal.write(current, data));
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (current) api.folderTerminal.resize(current, term.cols, term.rows);
    });
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      input.dispose();
      offData();
      offUrl();
      offExit();
      term.dispose();
    };
  }, [item.id, item.folder]);

  if (!item.folder) return null;

  return (
    <div className="panel term">
      <div className="panel-head">
        <strong>終端機</strong>
        <span className="muted small">{folder ?? item.folder}</span>
      </div>
      <div className="row">
        <button className="primary" onClick={() => api.folderTerminal.startSite(item.id).catch((e) => setError(errorText(e)))}>在本機啟動</button>
        <button onClick={() => folder && api.folderTerminal.interrupt(folder)}>停止</button>
        {url && <button className="primary" onClick={() => api.openUrl(url).catch((e) => setError(errorText(e)))}>打開網頁</button>}
      </div>
      {url && <div className="muted small">{url}</div>}
      <div ref={host} className="folder-term" />
      {exited && <div className="muted small">終端機已結束，切換到別張單再切回來會重新打開。</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function FileRow({ file, actions, onOpen, open }: { file: GitFile; actions: React.ReactNode; onOpen(): void; open: boolean }) {
  const name = file.path.split('/').pop();
  const dir = file.path.slice(0, file.path.length - (name?.length ?? 0));
  return (
    <li className={open ? 'open' : ''}>
      <button className="file-name" onClick={onOpen} title={file.path}>
        <span className={`code c-${file.code}`}>{file.code}</span> {name} <span className="muted small">{dir}</span>
      </button>
      <span className="file-actions">{actions}</span>
    </li>
  );
}

export function GitPanel({ item }: { item: WorkItem }) {
  const [state, setState] = useState<GitState | null>(null);
  const [message, setMessage] = useState(item.prTitle);
  const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    if (!item.folder) return;
    try {
      setState(await api.git.state(item.id));
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    setState(null);
    setDiff(null);
    setError(null);
    setNotice(null);
    setMessage(item.prTitle);
    refresh();
    // AI 在改檔案時，每 3 秒更新一次
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [item.id, item.folder]);

  async function act(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function showDiff(path: string, staged: boolean) {
    if (diff?.path === path && diff.staged === staged) return setDiff(null);
    try {
      setDiff({ path, staged, text: await api.git.diff(item.id, path, staged) });
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!item.folder) return null;
  if (!state) return <div className="panel"><strong>Git 改動</strong><p className="muted small">讀取中…</p>{error && <div className="error">{error}</div>}</div>;

  const onBranch = state.branch === item.branch;
  // 有新的提交才能推送：遠端已有分支時看還沒推送的數量；還沒有時看比基底多幾個提交
  const canPush = state.hasRemote ? (state.unpushed ?? 0) > 0 : state.ahead > 0;
  const diffBlock = (path: string, staged: boolean) => diff?.path === path && diff.staged === staged && <li className="diff-row"><DiffView diff={diff.text} /></li>;

  return (
    <div className="panel git">
      <div className="panel-head">
        <strong>Git 改動</strong>
        <code className="small">{state.branch || '（不在分支上）'}</code>
      </div>
      {!onBranch && <p className="warn">資料夾目前在 {state.branch}，不是這張單的 {item.branch}。</p>}

      <div className="git-section">
        <div className="git-section-head">
          <span>暫存的變更（{state.staged.length}）</span>
          {state.staged.length > 0 && <button className="link" disabled={busy} onClick={() => act(() => api.git.unstage(item.id, state.staged.map((f) => f.path)))}>全部取消暫存</button>}
        </div>
        <ul className="git-files">
          {state.staged.map((file) => (
            <FileRowWithDiff key={`s-${file.path}`} file={file} staged diffBlock={diffBlock} open={diff?.path === file.path && diff.staged} onOpen={() => showDiff(file.path, true)}
              actions={<button className="link" title="取消暫存" disabled={busy} onClick={() => act(() => api.git.unstage(item.id, [file.path]))}>−</button>} />
          ))}
        </ul>
      </div>

      <div className="git-section">
        <div className="git-section-head">
          <span>變更（{state.unstaged.length}）</span>
          {state.unstaged.length > 0 && <button className="link" disabled={busy} onClick={() => act(() => api.git.stage(item.id, state.unstaged.map((f) => f.path)))}>全部暫存</button>}
        </div>
        <ul className="git-files">
          {state.unstaged.map((file) => (
            <FileRowWithDiff key={`u-${file.path}`} file={file} staged={false} diffBlock={diffBlock} open={diff?.path === file.path && !diff.staged} onOpen={() => showDiff(file.path, false)}
              actions={
                <>
                  <button
                    className="link danger"
                    title="捨棄修改"
                    disabled={busy}
                    onClick={() => {
                      const what = file.code === 'U' ? '刪除這個新檔案' : '還原這個檔案的修改';
                      if (window.confirm(`${what}？\n${file.path}\n\n這個動作沒辦法復原。`)) act(() => api.git.discard(item.id, [file.path]));
                    }}
                  >
                    ↺
                  </button>
                  <button className="link" title="暫存" disabled={busy} onClick={() => act(() => api.git.stage(item.id, [file.path]))}>＋</button>
                </>
              }
            />
          ))}
        </ul>
        {state.unstaged.some((f) => /environments\/environment[^/]*\.ts$/.test(f.path)) && (
          <p className="muted small">environment.ts 通常是瀏覽器測試切 SIT／UAT 留下的，不用提交；按「完成這張單」時可以一起還原。</p>
        )}
      </div>

      {(state.staged.length > 0 || state.unstaged.length > 0) && (
        <div className="git-commit">
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="提交訊息" />
          <button className="primary" disabled={busy || !onBranch || state.staged.length === 0 || !message.trim()} onClick={() => act(() => api.git.commit(item.id, message), '已提交')}>
            {state.staged.length === 0 ? '先把要提交的檔案暫存（＋）' : `提交 ${state.staged.length} 個檔案`}
          </button>
        </div>
      )}
      {state.staged.length === 0 && state.unstaged.length === 0 && <p className="muted small">沒有未提交的改動。</p>}
      {canPush && (
        <button
          disabled={busy || !onBranch}
          onClick={() => {
            const what = state.hasRemote ? `推送 ${state.unpushed} 個提交到遠端的 ${state.branch}？` : `遠端還沒有 ${state.branch}，要建立並推送 ${state.ahead} 個提交嗎？`;
            if (window.confirm(what)) act(() => api.git.push(item.id), '已推送');
          }}
        >
          {state.hasRemote ? `推送 ${state.unpushed} 個提交` : `推送（建立遠端分支，${state.ahead} 個提交）`}
        </button>
      )}
      {notice && <div className="notice-ok">{notice}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function FileRowWithDiff({ file, staged, diffBlock, ...rest }: { file: GitFile; staged: boolean; diffBlock: (path: string, staged: boolean) => React.ReactNode; actions: React.ReactNode; onOpen(): void; open: boolean }) {
  return (
    <>
      <FileRow file={file} {...rest} />
      {diffBlock(file.path, staged)}
    </>
  );
}
