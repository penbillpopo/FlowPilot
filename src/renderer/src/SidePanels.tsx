// 工作台右邊：測試（SIT／UAT、測試帳號）、資料夾終端機（啟動本機網站、自己下指令）與 Git 改動（像 VS Code 的原始碼控制）
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { Env, GitFile, GitState, TestState, WorkItem } from '../../shared/types';
import { errorText } from './ChatPanel';
import { DiffView } from './DiffView';

const api = window.flowpilot;

const RESULT_MARK = { 通過: '✓', 沒過: '✗', 沒測: '—' } as const;

/** 測試結果：預期結果一條一條的對照，以及要你手動測的清單（勾選會存起來，重測後同樣的項目保留勾選） */
export function TestReportPanel({ item }: { item: WorkItem }) {
  const [error, setError] = useState<string | null>(null);
  const report = item.testReport;
  if (!report) return <div className="panel"><p className="muted small">瀏覽器測試做完後，這裡會列出每一條預期結果有沒有通過，以及要你手動測的項目。</p></div>;
  return (
    <div className="panel test-report">
      <div className="plan-block-title">預期結果對照</div>
      {report.acceptance.length === 0 && <p className="muted small">這次測試沒有逐條回報。</p>}
      <ul className="acceptance">
        {report.acceptance.map((a) => (
          <li key={a.no} className={`ac-${a.result}`}>
            <span className="ac-mark">{RESULT_MARK[a.result]}</span>
            <span>
              {a.no}. {a.text}
              {a.note && <span className="muted small">（{a.note}）</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="plan-block-title">要你手動測的項目</div>
      {report.manual.length === 0 && <p className="muted small">沒有。</p>}
      <ul className="manual-list">
        {report.manual.map((m, i) => (
          <li key={i}>
            <label className={m.done ? 'done' : ''}>
              <input type="checkbox" checked={m.done} onChange={(e) => api.test.setManualDone(item.id, i, e.target.checked).catch((err) => setError(errorText(err)))} />
              {m.text}
            </label>
          </li>
        ))}
      </ul>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/**
 * 測試：資料夾目前連 SIT 還是 UAT（只切換 environment.ts 的註解）、這次測試會用哪個帳號。
 * 帳號一律用帳號檔（~/.codex/local-test-configs）；畫面上只顯示帳號，不顯示密碼。
 */
export function TestPanel({ item }: { item: WorkItem }) {
  const [state, setState] = useState<TestState | null>(null);
  const [trying, setTrying] = useState(false);
  const [trial, setTrial] = useState<{ ok: boolean; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setError(null);
    const refresh = () => api.test.state(item.id).then(setState).catch((e) => setError(errorText(e)));
    refresh();
    // 你也可能在別的地方改了 environment.ts 或帳號檔
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [item.id, item.folder]);

  async function switchTo(env: Env) {
    setBusy(true);
    setError(null);
    try {
      setState(await api.test.setEnvironment(item.id, env));
    } catch (e) {
      setError(errorText(e));
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
            <button key={e} className={env === e ? 'on' : ''} disabled={busy || env === e || env === null} onClick={() => switchTo(e)}>
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
            {state.account.username}
            {!state.account.hasPassword && <span className="warn small">（還沒有密碼）</span>}
          </span>
        ) : (
          <span className="warn small">{env === 'sit' || env === 'uat' ? `帳號檔裡沒有 ${env.toUpperCase()} 的帳號` : '—'}</span>
        )}
      </div>
      {state && (!state.account || !state.account.hasPassword) && (env === 'sit' || env === 'uat') && (
        <p className="muted small">請在 {state.accountFile} 補上{state.account ? '密碼（passwordSource）' : ''}。</p>
      )}
      <div className="row trial-row">
        <button
          className="link small"
          disabled={trying || !(state?.account?.hasPassword)}
          title="用無頭瀏覽器照帳號檔登入看看（獨立的臨時對話，約一兩分鐘；本機網站沒在跑會先啟動）"
          onClick={async () => {
            setTrying(true);
            setTrial(null);
            setError(null);
            try {
              setTrial(await api.test.trialLogin(item.id));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setTrying(false);
            }
          }}
        >
          {trying ? '試登中…（約一兩分鐘）' : '試登一次'}
        </button>
        {trial && <span className={`small ${trial.ok ? 'ok-text' : 'warn'}`}>{trial.ok ? '登入成功' : '登入失敗'}：{trial.reason}</span>}
      </div>
      <button
        className="link small close-browsers"
        title="關掉瀏覽器測試開出來的瀏覽器視窗（不會關到你自己的 Chrome）"
        onClick={() => api.test.closeBrowsers().then((n) => setError(n ? null : '目前沒有測試開出來的瀏覽器')).catch((e) => setError(errorText(e)))}
      >
        關掉測試開的瀏覽器
      </button>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/** 資料夾終端機：固定顯示、可以直接輸入；「在本機啟動」會在這裡執行啟動指令，抓到網址後可以打開網頁 */
export function FolderTerminalPanel({ item, onSiteUrl }: { item: WorkItem; onSiteUrl?(url: string | null): void }) {
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
      // 切到別的分頁時是隱藏的（寬度 0），不要把終端機縮成一小條
      if (!host.current?.clientWidth) return;
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

  useEffect(() => onSiteUrl?.(url), [url]);

  if (!item.folder) return null;

  return (
    <div className="panel term">
      <div className="row">
        <button className="primary" onClick={() => api.folderTerminal.startSite(item.id).catch((e) => setError(errorText(e)))}>在本機啟動</button>
        <button onClick={() => folder && api.folderTerminal.interrupt(folder)}>停止</button>
        {url && <button className="primary" onClick={() => api.openUrl(url).catch((e) => setError(errorText(e)))}>打開網頁</button>}
        <span className="muted small push-right">{folder ?? item.folder}</span>
      </div>
      {url && <div className="muted small">{url}</div>}
      <div ref={host} className="folder-term" />
      {exited && <div className="muted small">終端機已結束，切換到別張單再切回來會重新打開。</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function FileRow({ file, actions, onOpen, open, note }: { file: GitFile; actions: React.ReactNode; onOpen(): void; open: boolean; note?: string }) {
  const name = file.path.split('/').pop();
  const dir = file.path.slice(0, file.path.length - (name?.length ?? 0));
  return (
    <li className={`${open ? 'open' : ''} ${note ? 'noted' : ''}`} title={note}>
      <button className="file-name" onClick={onOpen} title={file.path}>
        <span className={`code c-${file.code}`}>{file.code}</span> {name} <span className="muted small">{note ? '提交前檢查改的' : dir}</span>
      </button>
      <span className="file-actions">{actions}</span>
    </li>
  );
}

export function GitPanel({ item, onCount }: { item: WorkItem; onCount?(changes: number): void }) {
  const [state, setState] = useState<GitState | null>(null);
  const [message, setMessage] = useState(item.prTitle);
  /** 這一次提交改用的身分（信箱）；null 代表用資料夾設定的 */
  const [who, setWho] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 上次提交時，被專案的提交前檢查順手改到的無關檔案 */
  const [hookChanged, setHookChanged] = useState<string[]>([]);
  /** 提交中（專案的提交前檢查可能要等幾十秒） */
  const [committing, setCommitting] = useState(false);

  // 「已提交」「已捨棄」這類回饋幾秒後自動消失，不會一直殘留
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function refresh() {
    if (!item.folder) return;
    try {
      const next = await api.git.state(item.id);
      setState(next);
      onCount?.(next.staged.length + next.unstaged.length);
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    setState(null);
    setDiff(null);
    setError(null);
    setNotice(null);
    setHookChanged([]);
    setMessage(item.prTitle);
    setWho(null);
    refresh();
    // AI 在改檔案時，每 3 秒更新一次
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [item.id, item.folder]);

  // AI 一輪做完（狀態改變）就馬上更新，不用等下一次的 3 秒
  useEffect(() => {
    refresh();
  }, [item.status]);

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
  // 可以選的身分：設定檔列的，加上資料夾目前設定的（如果不在清單裡）
  const identityOptions = [
    ...(state.identity.email && !state.identities.some((i) => i.email === state.identity.email) ? [state.identity] : []),
    ...state.identities,
  ];
  const chosen = who ?? state.identity.email;
  // 還留在資料夾裡的（你自己捨棄或提交了就不再提示）
  const dirtyPaths = new Set([...state.staged, ...state.unstaged].map((f) => f.path));
  const pendingHook = hookChanged.filter((p) => dirtyPaths.has(p));
  const ownChanges = state.unstaged.filter((f) => !pendingHook.includes(f.path));
  const canPush = state.hasRemote ? (state.unpushed ?? 0) > 0 : state.ahead > 0;
  const diffBlock = (path: string, staged: boolean) => diff?.path === path && diff.staged === staged && <li className="diff-row"><DiffView diff={diff.text} /></li>;

  return (
    <div className="panel git">
      <div className="panel-head">
        <span className="muted small">目前分支</span>
        <code className="small">{state.branch || '（不在分支上）'}</code>
      </div>
      {!onBranch && <p className="warn">資料夾目前在 {state.branch}，不是這張單的 {item.branch}。</p>}
      {notice && <div className="notice-ok">{notice}</div>}
      {error && <div className="error">{error}</div>}
      {pendingHook.length > 0 && (
        <div className="hook-notice warn small">
          提交前的檢查（專案設定的 lint 等）順手改了 {pendingHook.length} 個跟這次無關的檔案，它們沒有被提交，還留在資料夾裡：
          <ul>{pendingHook.slice(0, 5).map((p) => <li key={p} title={p}><code>{p.split('/').pop()}</code></li>)}{pendingHook.length > 5 && <li>…等 {pendingHook.length} 個</li>}</ul>
          <div className="row">
            <button
              className="danger"
              disabled={busy}
              onClick={() => window.confirm(`捨棄這 ${pendingHook.length} 個檔案的修改？只會還原這些被檢查改到的檔案。`) && act(async () => {
                await api.git.discard(item.id, pendingHook);
                setHookChanged([]);
              }, '已捨棄')}
            >
              全部捨棄
            </button>
            <button disabled={busy} onClick={() => setHookChanged([])}>先不管</button>
          </div>
        </div>
      )}

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
          {ownChanges.length > 0 && <button className="link" disabled={busy} onClick={() => act(() => api.git.stage(item.id, ownChanges.map((f) => f.path)))} title={pendingHook.length ? '不含提交前檢查改到的檔案' : undefined}>全部暫存</button>}
        </div>
        <ul className="git-files">
          {state.unstaged.map((file) => (
            <FileRowWithDiff key={`u-${file.path}`} file={file} staged={false} diffBlock={diffBlock} open={diff?.path === file.path && !diff.staged} onOpen={() => showDiff(file.path, false)}
              note={pendingHook.includes(file.path) ? `提交前的檢查改到的，跟這次無關：${file.path}` : undefined}
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
          {identityOptions.length > 1 && (
            <label className="identity">
              <span className="muted small">提交身分</span>
              <select value={chosen} onChange={(e) => setWho(e.target.value === state.identity.email ? null : e.target.value)}>
                {identityOptions.map((i) => (
                  <option key={i.email} value={i.email}>
                    {i.name} &lt;{i.email}&gt;{i.email === state.identity.email ? '（資料夾預設）' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {who && <p className="warn small">這一次提交會用 {who}，不是資料夾預設的 {state.identity.email || '（沒有設定）'}；只套用在這一次。</p>}
          <button
            className="primary"
            disabled={busy || !onBranch || state.staged.length === 0 || !message.trim()}
            onClick={() => act(async () => {
              setCommitting(true);
              try {
                const result = await api.git.commit(item.id, message, who ?? undefined);
                setWho(null); // 下次提交回到資料夾預設
                setHookChanged(result.hookChanged);
              } finally {
                setCommitting(false);
              }
            }, '已提交')}
          >
            {committing ? '提交中…（專案的提交前檢查可能要等幾十秒）' : state.staged.length === 0 ? '先把要提交的檔案暫存（＋）' : `提交 ${state.staged.length} 個檔案`}
          </button>
        </div>
      )}
      {state.staged.length === 0 && state.unstaged.length === 0 && <p className="muted small">沒有未提交的改動。</p>}
      {/* AI 還在改的時候不放推送，避免誤按 */}
      {canPush && !['running', 'preparing'].includes(item.status) && (
        <button
          className="push-button"
          disabled={busy || !onBranch}
          onClick={() => {
            const what = state.needsForce
              ? `遠端的 ${state.branch} 跟本機的歷史不一樣（通常是 rebase 過），要強制推送嗎？\n\n會用 --force-with-lease：如果遠端在你上次推送後被別人推了新的提交，會拒絕覆蓋。`
              : state.hasRemote ? `推送 ${state.unpushed} 個提交到遠端的 ${state.branch}？` : `遠端還沒有 ${state.branch}，要建立並推送 ${state.ahead} 個提交嗎？`;
            if (window.confirm(what)) act(() => api.git.push(item.id), '已推送');
          }}
        >
          {state.needsForce ? '強制推送（rebase 過）' : state.hasRemote ? `推送 ${state.unpushed} 個提交` : `推送（建立遠端分支，${state.ahead} 個提交）`}
        </button>
      )}
    </div>
  );
}

function FileRowWithDiff({ file, staged, diffBlock, ...rest }: { file: GitFile; staged: boolean; diffBlock: (path: string, staged: boolean) => React.ReactNode; actions: React.ReactNode; onOpen(): void; open: boolean; note?: string }) {
  return (
    <>
      <FileRow file={file} {...rest} />
      {diffBlock(file.path, staged)}
    </>
  );
}
