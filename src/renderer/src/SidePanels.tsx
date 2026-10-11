// 工作台右邊：測試（SIT／UAT、測試帳號）、資料夾終端機（啟動本機網站、自己下指令）與 Git 改動（像 VS Code 的原始碼控制）
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { Env, GitFile, TestState, WorkItem } from '../../shared/types';
import { errorText } from './ChatPanel';
import { DiffView } from './DiffView';
import { needsYou, unexplainedFiles } from '../../shared/acceptance';
import { commitPrefs, deliveryOf, isTestOnly, setCommitPrefs, useGitState } from './delivery';

const api = window.flowpilot;

/** 需要你測的條目還沒勾「我測過了」的數量，加上沒勾的其他手動項目（分頁上的數字） */
export function pendingChecks(item: WorkItem): number {
  const report = item.testReport;
  if (!report) return 0;
  return report.acceptance.filter((a) => needsYou(a) && !a.checked).length + report.manual.filter((m) => !m.done).length;
}

const askAI = (text: string) => window.dispatchEvent(new CustomEvent('flowpilot:ask-ai', { detail: text }));
const fileName = (path: string) => path.split('/').pop() ?? path;

/**
 * 驗收：以需求為主軸的驗收表（由開發的 AI 寫）。每一條：改了什麼、為什麼、改在哪、會影響哪裡、怎麼測，加上 AI 的測試結果。
 * 要你注意的地方放最上面；實際改到、但驗收表沒提到的檔案用紅字標出來（FlowPilot 自己核對，不只信 AI 說的）。
 */
export function AcceptancePanel({ item }: { item: WorkItem }) {
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<string[] | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const report = item.testReport;

  // 驗收表更新、AI 一輪做完時重新核對改到的檔案
  useEffect(() => {
    if (!item.folder || !report) return;
    api.test.changedFiles(item.id).then(setChanged).catch(() => setChanged(null));
  }, [item.id, item.testReport, item.status]);

  const run = (action: () => Promise<unknown>) => action().catch((e) => setError(errorText(e)));
  const idle = !!item.threadId && ['review', 'waiting'].includes(item.status) && !item.pending;

  if (!report) {
    return (
      <div className="panel">
        <p className="muted small">AI 做完開發、測試完之後，這裡會列出驗收表：每一條需求改了什麼、為什麼、改在哪、會影響哪裡、你要怎麼測。</p>
        {idle && item.stage === 'manual' && (
          <button onClick={() => run(() => api.test.requestAcceptance(item.id))} title="不重新測試，請 AI 照目前的改動整理驗收表">請 AI 整理驗收表</button>
        )}
        {error && <div className="error small">{error}</div>}
      </div>
    );
  }

  // 舊的驗收表沒有這些欄位（只有測試結果），就不核對
  const detailed = report.acceptance.some((a) => a.change || a.files.length);
  const unexplained = detailed && changed ? unexplainedFiles(changed, [...report.acceptance.flatMap((a) => a.files), ...report.otherChanges.flatMap((c) => c.files)]) : [];
  const forYou = report.acceptance.filter(needsYou);
  const left = forYou.filter((a) => !a.checked).length;

  return (
    <div className="panel acceptance-panel">
      <div className="ac-summary">
        <strong>{left ? `要你測 ${left} 條` : forYou.length ? '要你測的都測過了' : '都由 AI 測過了'}</strong>
        <span className="muted small">共 {report.acceptance.length} 條</span>
      </div>

      {(report.attention.length > 0 || unexplained.length > 0) && (
        <div className="ac-attention">
          <div className="plan-block-title">⚠ 要你注意</div>
          <ul>
            {report.attention.map((t, i) => <li key={i}>{t}</li>)}
            {unexplained.length > 0 && (
              <li className="bad" title={unexplained.join('\n')}>
                有 {unexplained.length} 個檔案改了但驗收表沒說明：{unexplained.slice(0, 4).map(fileName).join('、')}{unexplained.length > 4 ? ' 等' : ''}
                <button className="link small" onClick={() => askAI(`驗收表沒說明這些檔案為什麼改：${unexplained.join('、')}。請說明，不需要的改動請還原。`)}>問 AI</button>
              </li>
            )}
          </ul>
        </div>
      )}

      <ul className="ac-list">
        {report.acceptance.map((a) => {
          const mine = needsYou(a);
          const expanded = open.has(a.no) || (mine && !a.checked && detailed);
          const badge = a.result === '沒過' ? { text: '沒過', cls: 'bad' } : mine ? { text: a.checked ? '你測過了' : '要你測', cls: a.checked ? 'ok' : 'you' } : { text: 'AI 測過', cls: 'ok' };
          const toggle = () => setOpen((prev) => {
            const next = new Set(prev);
            expanded ? next.delete(a.no) : next.add(a.no);
            return next;
          });
          return (
            <li key={a.no} className={`ac-item ${mine && !a.checked ? 'mine' : 'quiet'}`}>
              <button className="ac-head" onClick={toggle} title={expanded ? '收起' : '展開'}>
                <span className={`ac-badge ${badge.cls}`}>{badge.text}</span>
                <span className="ac-title">{a.no}. {a.text}</span>
                {a.changed && <span className="ac-new" title="這次修改或重測後內容有變，要重新看">有變動</span>}
              </button>
              {expanded && (
                <div className="ac-body">
                  {a.change && <p><span className="ac-label">改了</span>{a.change}</p>}
                  {a.why && <p><span className="ac-label">為什麼</span>{a.why}</p>}
                  {a.files.length > 0 && (
                    <p title={a.files.join('\n')}><span className="ac-label">改在</span>{a.files.map(fileName).join('、')}</p>
                  )}
                  <p><span className="ac-label">也影響</span>{a.impact || (detailed ? '沒有' : '—')}</p>
                  {a.howToTest && <p className="ac-how"><span className="ac-label">怎麼測</span>{a.howToTest}</p>}
                  {a.note && <p className="muted small"><span className="ac-label">AI 測試</span>{a.result}：{a.note}</p>}
                  <div className="ac-actions">
                    {mine && (
                      <label>
                        <input type="checkbox" checked={a.checked} onChange={(e) => run(() => api.test.setChecked(item.id, a.no, e.target.checked))} />
                        我測過了
                      </label>
                    )}
                    {a.page && item.folder && (
                      <button className="link small" title="在你的瀏覽器打開本機網站這一頁（網站沒開會先啟動）" onClick={() => run(() => api.test.openPage(item.id, a.page))}>
                        打開這頁
                      </button>
                    )}
                    <button className="link small" title="這一條有問題？在輸入框帶入，跟 AI 說要怎麼改" onClick={() => askAI(`驗收第 ${a.no} 條（${a.text}）：`)}>
                      跟 AI 說
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {report.otherChanges.length > 0 && (
        <>
          <div className="plan-block-title">其他也改到的</div>
          <ul className="ac-list">
            {report.otherChanges.map((c, i) => (
              <li key={i} className="ac-item quiet">
                <div className="ac-body">
                  <p><span className="ac-label">改了</span>{c.change}</p>
                  {c.why && <p><span className="ac-label">為什麼</span>{c.why}</p>}
                  {c.files.length > 0 && <p title={c.files.join('\n')}><span className="ac-label">改在</span>{c.files.map(fileName).join('、')}</p>}
                  {c.impact && <p><span className="ac-label">也影響</span>{c.impact}</p>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {report.manual.length > 0 && (
        <>
          <div className="plan-block-title">其他要你手動測的</div>
          <ul className="manual-list">
            {report.manual.map((m, i) => (
              <li key={i}>
                <label className={m.done ? 'done' : ''}>
                  <input type="checkbox" checked={m.done} onChange={(e) => run(() => api.test.setManualDone(item.id, i, e.target.checked))} />
                  {m.text}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {idle && item.stage === 'manual' && (
        <button className="link small" onClick={() => run(() => api.test.requestAcceptance(item.id))} title="不重新測試，請 AI 照目前的改動重新整理驗收表">
          請 AI 重新整理驗收表
        </button>
      )}
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
  const [showTerminal, setShowTerminal] = useState(false);

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
      <div className="site-status">
        <span className={`site-dot ${url ? 'on' : ''}`} />
        {url ? <span>本機網站在跑：<code>{url}</code></span> : <span className="muted">本機網站沒有在跑</span>}
      </div>
      <div className="row">
        {url ? (
          <>
            <button className="primary" onClick={() => api.openUrl(url).catch((e) => setError(errorText(e)))}>打開網頁</button>
            <button onClick={() => folder && api.folderTerminal.interrupt(folder)}>停止</button>
          </>
        ) : (
          <button className="primary" onClick={() => api.folderTerminal.startSite(item.id).catch((e) => setError(errorText(e)))}>啟動</button>
        )}
        {/* 終端機是開發者的工具，平常收起來；真的需要時再打開 */}
        <button className="link small push-right" onClick={() => setShowTerminal(!showTerminal)}>{showTerminal ? '收起終端機' : '顯示終端機'}</button>
      </div>
      <div ref={host} className="folder-term" style={showTerminal ? undefined : { display: 'none' }} />
      {exited && <div className="muted small">終端機已結束，切換到別張單再切回來會重新打開。</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/**
 * 改動：給操作者看的。唯讀列出 AI 改了哪些檔案（點檔名看改了什麼），一顆主要按鈕永遠是「下一步」：
 * 有改動 → 提交；提交完還沒推送 → 推送。不放暫存、還原這些開發者的動作；覺得哪裡不對就「跟 AI 說」。
 */
export function GitPanel({ item, onCount }: { item: WorkItem; onCount?(changes: number): void }) {
  const { state, error: loadError } = useGitState(item);
  const [message, setMessage] = useState(commitPrefs(item.id).message ?? item.prTitle);
  const [who, setWho] = useState<string | null>(commitPrefs(item.id).who ?? null);
  const [editing, setEditing] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const delivery = deliveryOf(item, state);
  useEffect(() => {
    if (delivery) onCount?.(delivery.changes.length);
  }, [delivery?.changes.length]);

  async function showDiff(file: GitFile) {
    if (diff?.path === file.path) return setDiff(null);
    try {
      // 暫存過的和沒暫存的都看得到：先看沒暫存的，沒有內容就看暫存的
      let text = await api.git.diff(item.id, file.path, false);
      if (!text.trim()) text = await api.git.diff(item.id, file.path, true);
      setDiff({ path: file.path, text });
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!item.folder) return null;
  if (!state || !delivery) return <div className="panel"><p className="muted small">讀取中…</p>{!!loadError && <div className="error">{errorText(loadError)}</div>}</div>;

  const { changes, pushCount, onBranch } = delivery;
  const files = [...state.staged, ...state.unstaged].filter((f, i, all) => all.findIndex((x) => x.path === f.path) === i);
  const testOnly = files.filter((f) => isTestOnly(f.path));
  const aiWorking = ['running', 'preparing'].includes(item.status);
  const identityOptions = [
    ...(state.identity.email && !state.identities.some((i) => i.email === state.identity.email) ? [state.identity] : []),
    ...state.identities,
  ];

  // 提交、推送用標題列的主要按鈕；這裡只說明現在的狀況
  const status = !onBranch
    ? `資料夾目前在 ${state.branch}，不是這張單的分支 ${item.branch}`
    : changes.length
      ? aiWorking ? 'AI 還在改，做完之後用上方的「提交」按鈕提交' : '確認沒問題後，用上方的「提交」按鈕提交'
      : pushCount > 0
        ? `有 ${pushCount} 個提交還沒推送，用上方的「推送」按鈕推送`
        : state.hasRemote && state.ahead > 0 ? '改動都已推送到遠端' : '';

  return (
    <div className="panel git">
      <div className="panel-head">
        <span className="muted small">分支</span>
        <code className="small">{state.branch || '（不在分支上）'}</code>
      </div>
      {(error || !!loadError) && <div className="error">{error ?? errorText(loadError)}</div>}
      {status && <p className="muted small git-status">{status}</p>}

      <div className="git-section">
        <div className="git-section-head"><span>AI 改了 {changes.length} 個檔案</span></div>
        {changes.length === 0 && <p className="muted small">{pushCount > 0 || state.ahead > 0 ? '改動都提交了。' : '目前沒有改動。'}</p>}
        <ul className="git-files">
          {changes.map((file) => {
            const name = file.path.split('/').pop();
            return (
              <li key={file.path} className={diff?.path === file.path ? 'open' : ''}>
                <button className="file-name" onClick={() => showDiff(file)} title={`${file.path}（點一下看改了什麼）`}>
                  <span className={`code c-${file.code}`}>{CHANGE_LABEL[file.code] ?? '修改'}</span> {name} <span className="muted small">{file.path.slice(0, file.path.length - (name?.length ?? 0))}</span>
                </button>
                <button
                  className="link small file-actions"
                  title="這個檔案改得不對？在輸入框帶入檔名，跟 AI 說要怎麼改"
                  onClick={() => window.dispatchEvent(new CustomEvent('flowpilot:ask-ai', { detail: `${file.path}：` }))}
                >
                  跟 AI 說
                </button>
                {diff?.path === file.path && <div className="diff-row"><DiffView diff={diff.text} /></div>}
              </li>
            );
          })}
        </ul>
        {testOnly.length > 0 && <p className="muted small">environment.ts 是測試時切環境改的，不會提交；完成這張單時會還原。</p>}
      </div>

      {changes.length > 0 && onBranch && (
        <div className="git-commit">
          <button className="link small" onClick={() => setEditing(!editing)}>{editing ? '收起' : '修改提交訊息'}</button>
          {editing && (
            <>
              <input
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setCommitPrefs(item.id, { message: e.target.value });
                }}
                placeholder="提交訊息"
              />
              {identityOptions.length > 1 && (
                <label className="identity">
                  <span className="muted small">提交身分（只套用在這一次）</span>
                  <select
                    value={who ?? state.identity.email}
                    onChange={(e) => {
                      const next = e.target.value === state.identity.email ? null : e.target.value;
                      setWho(next);
                      setCommitPrefs(item.id, { who: next });
                    }}
                  >
                    {identityOptions.map((i) => (
                      <option key={i.email} value={i.email}>
                        {i.name} &lt;{i.email}&gt;{i.email === state.identity.email ? '（預設）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Git 的代號換成操作者看得懂的字 */
const CHANGE_LABEL: Record<string, string> = { M: '修改', A: '新增', U: '新增', D: '刪除', R: '改名', C: '複製' };

