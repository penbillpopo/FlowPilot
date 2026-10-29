// 工作台右邊：測試（SIT／UAT、測試帳號）、資料夾終端機（啟動本機網站、自己下指令）與 Git 改動（像 VS Code 的原始碼控制）
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { AcceptanceItem, BranchCommits, Env, GitFile, SpecCheckItem, TestState, WorkItem } from '../../shared/types';
import { specItemsForYou } from '../../shared/types';
import { errorText } from './ChatPanel';
import { DiffView } from './DiffView';
import { needsYou, unexplainedFiles } from '../../shared/acceptance';
import { commitPrefs, deliveryOf, isTestOnly, setCommitPrefs, useGitState } from './delivery';
import { t, zhOnly } from '../../shared/i18n';

const api = window.flowpilot;

/** 需要你測的條目還沒勾「我測過了」的數量，加上沒勾的其他手動項目、規格比對還要你看的（分頁上的數字） */
export function pendingChecks(item: WorkItem): number {
  const report = item.testReport;
  const spec = specItemsForYou(item.specCheck).length;
  if (!report) return spec;
  return report.acceptance.filter((a) => needsYou(a) && !a.checked).length + report.manual.filter((m) => !m.done).length + spec;
}

// i18n-keys：顯示時才翻
const SPEC_SEVERITY: Record<SpecCheckItem['severity'], string> = { high: '嚴重', medium: '中', low: '輕微' };

/**
 * 規格比對：沒看過開發過程的 AI 拿開工前的規格比對改動。
 * 做錯的交給開發的 AI 修；它不改的（附理由）、不確定誰對的（可能是規格寫錯）要你看過、勾「我看過了」。
 */
function SpecCheckBlock({ item, run }: { item: WorkItem; run(action: () => Promise<unknown>): void }) {
  const check = item.specCheck;
  if (!check) return null;
  if (check.status === 'running') return <div className="spec-check muted small">⏳ {t('沒看過開發過程的 AI 比對規格和改動中…')}</div>;
  if (check.status === 'failed') return <div className="spec-check muted small">{t('規格比對沒有完成：{error}', { error: check.error ?? '' })}</div>;
  const forYou = specItemsForYou(check);
  const fixed = check.items.filter((i) => i.status === 'fixed');
  const rest = check.items.filter((i) => i.status !== 'fixed' && !forYou.includes(i));
  const row = (i: SpecCheckItem, mine: boolean) => (
    <li key={i.no} className={`spec-item ${mine ? 'mine' : 'quiet'}`}>
      <div className="spec-item-head">
        <span className={`spec-tag ${i.kind}`}>{i.kind === 'wrong' ? (i.status === 'fixed' ? t('已修正') : i.status === 'kept' ? t('AI 認為不用改') : t('做錯了')) : t('不確定誰對')}</span>
        <span className={`spec-sev ${i.severity}`}>{t(SPEC_SEVERITY[i.severity])}</span>
        <span>{i.text}</span>
      </div>
      {i.reply && <p className="small"><span className="ac-label">{i.status === 'kept' ? t('AI 的理由') : t('AI 改了')}</span>{i.reply}</p>}
      {i.kind === 'unsure' && <p className="muted small">{t('程式跟規格不一樣，但規格那段沒有根據，可能是規格寫錯：照單子想一下哪個對，不對就跟 AI 說。')}</p>}
      {i.evidence && (
        <details className="ac-dev">
          <summary>{t('證據')}</summary>
          <p className="small">{i.evidence}</p>
        </details>
      )}
      {mine && (
        <div className="ac-actions">
          <label>
            <input type="checkbox" checked={!!i.seen} onChange={(e) => run(() => api.test.setSpecSeen(item.id, i.no, e.target.checked))} />
            {t('我看過了')}
          </label>
          <button className="link small" onClick={() => askAI(t('規格比對第 {no} 條（{text}）：', { no: i.no, text: i.text }))}>{t('跟 AI 說')}</button>
        </div>
      )}
      {!mine && i.seen && (
        <div className="ac-actions">
          <label className="muted small">
            <input type="checkbox" checked onChange={() => run(() => api.test.setSpecSeen(item.id, i.no, false))} />
            {t('我看過了')}
          </label>
        </div>
      )}
    </li>
  );
  return (
    <div className="spec-check">
      <div className="plan-block-title">{t('規格比對')}</div>
      <p className="muted small">
        {check.items.length ? t('找到 {count} 條，{left} 條要你看（做錯的會先交給 AI 修）', { count: check.items.length, left: forYou.length }) : t('改動跟規格一致')}
        {check.verdict && <> {check.verdict}</>}
      </p>
      {forYou.length > 0 && <ul className="ac-list">{forYou.map((i) => row(i, true))}</ul>}
      {(fixed.length > 0 || rest.length > 0) && (
        <details className="ac-ai-tested">
          <summary>{t('已處理的（{count}）', { count: fixed.length + rest.length })}</summary>
          <ul className="ac-list">{[...fixed, ...rest].map((i) => row(i, false))}</ul>
        </details>
      )}
    </div>
  );
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
        <SpecCheckBlock item={item} run={run} />
        <p className="muted small">{t('AI 做完開發、測試完之後，這裡會列出驗收表：每一條需求改了什麼、為什麼、改在哪、會影響哪裡、你要怎麼測。')}</p>
        {idle && item.stage === 'manual' && (
          <button onClick={() => run(() => api.test.requestAcceptance(item.id))} title={t('不重新測試，請 AI 照目前的改動整理驗收表')}>{t('請 AI 整理驗收表')}</button>
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

  /** 一條驗收：標題照 Jira 原文；打開／做／應該看到三行；AI 測試時的截圖；開發資訊另外摺起來 */
  function renderItem(a: AcceptanceItem, mine: boolean) {
    const expanded = open.has(a.no) || (mine && !a.checked);
    const badge = a.result === zhOnly('沒過') ? { text: t('沒過'), cls: 'bad' } : mine ? { text: a.checked ? t('你測過了') : t('要你測'), cls: a.checked ? 'ok' : 'you' } : { text: t('AI 測過'), cls: 'ok' };
    const toggle = () => setOpen((prev) => {
      const next = new Set(prev);
      expanded ? next.delete(a.no) : next.add(a.no);
      return next;
    });
    const steps = a.open || a.act || a.expect;
    const devInfo = a.change || a.why || a.files.length > 0 || a.impact || a.note;
    return (
      <li key={a.no} className={`ac-item ${mine && !a.checked ? 'mine' : 'quiet'}`}>
        <button className="ac-head" onClick={toggle} title={expanded ? t('收起') : t('展開')}>
          <span className={`ac-badge ${badge.cls}`}>{badge.text}</span>
          <span className="ac-title">{a.no}. {a.text}</span>
          {a.fromAi && <span className="ac-from-ai" title={t('Jira 沒寫預期結果，這一條是 AI 整理的')}>{t('AI 整理')}</span>}
          {a.mocked && <span className="ac-mocked" title={t('用假資料測的：後端好了要用真的 API 重測')}>{t('假資料測的')}</span>}
          {a.changed && <span className="ac-new" title={t('這次修改或重測後內容有變，要重新看')}>{t('有變動')}</span>}
        </button>
        {expanded && (
          <div className="ac-body">
            {steps ? (
              <ol className="ac-steps">
                {a.open && <li><span className="ac-label">{t('打開')}</span>{a.open}</li>}
                {a.act && <li><span className="ac-label">{t('做')}</span>{a.act}</li>}
                {a.expect && <li><span className="ac-label">{t('應該看到')}</span>{a.expect}</li>}
              </ol>
            ) : (
              a.howToTest && <p className="ac-how"><span className="ac-label">{t('怎麼測')}</span>{a.howToTest}</p>
            )}
            {a.shot && <AcceptanceShot name={a.shot} />}
            <div className="ac-actions">
              {mine && (
                <label>
                  <input type="checkbox" checked={a.checked} onChange={(e) => run(() => api.test.setChecked(item.id, a.no, e.target.checked))} />
                  {t('我測過了')}
                </label>
              )}
              {a.page && !/\/:/.test(a.page) && item.folder && (
                <button className="link small" title={t('在你的瀏覽器打開本機網站這一頁（網站沒開會先啟動）')} onClick={() => run(() => api.test.openPage(item.id, a.page))}>
                  {t('打開這頁')}
                </button>
              )}
              <button className="link small" title={t('這一條有問題？在輸入框帶入，跟 AI 說要怎麼改')} onClick={() => askAI(t('驗收第 {no} 條（{text}）：', { no: a.no, text: a.text }))}>
                {t('不對，跟 AI 說')}
              </button>
            </div>
            {devInfo && (
              <details className="ac-dev">
                <summary>{t('開發資訊')}</summary>
                {a.change && <p><span className="ac-label">{t('改了')}</span>{a.change}</p>}
                {a.why && <p><span className="ac-label">{t('為什麼')}</span>{a.why}</p>}
                {a.files.length > 0 && <p title={a.files.join('\n')}><span className="ac-label">{t('改在')}</span>{a.files.map(fileName).join(t('、'))}</p>}
                {a.impact && <p><span className="ac-label">{t('也影響')}</span>{a.impact}</p>}
                {a.note && <p className="muted small"><span className="ac-label">{t('AI 測試')}</span>{a.result}{t('：')}{a.note}</p>}
              </details>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="panel acceptance-panel">
      <div className="ac-summary">
        <strong>{left ? t('要你測 {left} 條', { left }) : forYou.length ? t('要你測的都測過了') : t('都由 AI 測過了')}</strong>
        <span className="muted small">{t('共 {count} 條', { count: report.acceptance.length })}</span>
        <button className="link small ac-export" title={t('匯出成 CSV（Excel 打得開）')} onClick={() => run(() => api.test.exportCsv(item.id))}>{t('匯出 CSV')}</button>
      </div>
      {!!report.finishedUntested && <div className="ac-untested small">{t('⚠️ 這張單是直接完成的：當時還有 {count} 項沒測', { count: report.finishedUntested })}</div>}

      {(report.attention.length > 0 || unexplained.length > 0) && (
        <div className="ac-attention">
          <div className="plan-block-title">⚠ {t('要你注意')}</div>
          <ul>
            {report.attention.map((t, i) => <li key={i}>{t}</li>)}
            {unexplained.length > 0 && (
              <li className="bad" title={unexplained.join('\n')}>
                {t('有 {count} 個檔案改了但驗收表沒說明：', { count: unexplained.length })}{unexplained.slice(0, 4).map(fileName).join(t('、'))}{unexplained.length > 4 ? t(' 等') : ''}
                <button className="link small" onClick={() => askAI(t('驗收表沒說明這些檔案為什麼改：{files}。請說明，不需要的改動請還原。', { files: unexplained.join(t('、')) }))}>{t('問 AI')}</button>
              </li>
            )}
          </ul>
        </div>
      )}

      <SpecCheckBlock item={item} run={run} />

      {/* 要你測的排前面，做成三行步驟的卡片；AI 已經測過的收起來，要看再展開 */}
      <ul className="ac-list">
        {report.acceptance.filter((a) => needsYou(a)).map((a) => renderItem(a, true))}
      </ul>
      {(report.acceptance.some((a) => !needsYou(a)) || report.manual.some((m) => m.byAi)) && (
        <details className="ac-ai-tested">
          <summary>{t('AI 測過的（{count}）', { count: report.acceptance.filter((a) => !needsYou(a)).length + report.manual.filter((m) => m.byAi).length })}</summary>
          <ul className="ac-list">{report.acceptance.filter((a) => !needsYou(a)).map((a) => renderItem(a, false))}</ul>
          {report.manual.some((m) => m.byAi) && (
            <ul className="manual-list">
              {report.manual.filter((m) => m.byAi).map((m) => <li key={m.text} className="muted small">✓ {m.text}</li>)}
            </ul>
          )}
        </details>
      )}

      {report.otherChanges.length > 0 && (
        <>
          <div className="plan-block-title">{t('其他也改到的')}</div>
          <ul className="ac-list">
            {report.otherChanges.map((c, i) => (
              <li key={i} className="ac-item quiet">
                <div className="ac-body">
                  <p><span className="ac-label">{t('改了')}</span>{c.change}</p>
                  {c.why && <p><span className="ac-label">{t('為什麼')}</span>{c.why}</p>}
                  {c.files.length > 0 && <p title={c.files.join('\n')}><span className="ac-label">{t('改在')}</span>{c.files.map(fileName).join(t('、'))}</p>}
                  {c.impact && <p><span className="ac-label">{t('也影響')}</span>{c.impact}</p>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {report.manual.some((m) => !m.byAi) && (
        <>
          <div className="plan-block-title">{t('其他要你手動測的')}</div>
          <ul className="manual-list">
            {report.manual.map((m, i) => m.byAi ? null : (
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
        <button className="link small" onClick={() => run(() => api.test.requestAcceptance(item.id))} title={t('不重新測試，請 AI 照目前的改動重新整理驗收表')}>
          {t('請 AI 重新整理驗收表')}
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
        <strong>{t('測試')}</strong>
        <span className="muted small">{t('本機連的環境與登入帳號')}</span>
      </div>
      <div className="test-row">
        <span className="test-label">{t('環境')}</span>
        <div className="segmented">
          {(['sit', 'uat'] as Env[]).map((e) => (
            <button key={e} className={env === e ? 'on' : ''} disabled={busy || env === null} title={env === e ? t('再按一次會重新套用（例如 UAT 要用 SIT 多語系的那行）') : undefined} onClick={() => switchTo(e)}>
              {e.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {env === 'mixed' && <p className="warn small">{t('environment.ts 的 SIT、UAT 兩組都開著或都註解掉了，選一個就會整理好。')}</p>}
      {env === null && state && <p className="muted small">{t('environment.ts 裡找不到 SIT／UAT 的標記，沒辦法切換。')}</p>}
      <div className="test-row">
        <span className="test-label">{t('帳號')}</span>
        {state?.account ? (
          <span>
            {state.account.username}
            {!state.account.hasPassword && <span className="warn small">{t('（還沒有密碼）')}</span>}
          </span>
        ) : (
          <span className="warn small">{env === 'sit' || env === 'uat' ? t('帳號檔裡沒有 {env} 的帳號', { env: env.toUpperCase() }) : '—'}</span>
        )}
      </div>
      {state && (!state.account || !state.account.hasPassword) && (env === 'sit' || env === 'uat') && (
        <p className="muted small">{state.account ? t('請在 {file} 補上密碼（passwordSource）。', { file: state.accountFile }) : t('請在 {file} 補上。', { file: state.accountFile })}</p>
      )}
      <button
        className="link small close-browsers"
        title={t('關掉瀏覽器測試開出來的瀏覽器視窗（不會關到你自己的 Chrome）')}
        onClick={() => api.test.closeBrowsers().then((n) => setError(n ? null : t('目前沒有測試開出來的瀏覽器'))).catch((e) => setError(errorText(e)))}
      >
        {t('關掉測試開的瀏覽器')}
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
  // 按了「啟動」到網站起來之前：顯示啟動中、經過幾秒、終端機最後一行（不然看起來像沒反應）
  const [starting, setStarting] = useState<number | null>(null);
  const [lastLine, setLastLine] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (starting === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [starting]);
  useEffect(() => {
    if (url) setStarting(null);
  }, [url]);

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
    const offData = api.folderTerminal.onData((f, data) => {
      if (f !== current) return;
      term.write(data);
      // 終端機最後一行有字的輸出（拿掉顏色控制碼），啟動中顯示給你看進度
      const line = data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) setLastLine(line.slice(0, 120));
    });
    const offUrl = api.folderTerminal.onUrl((f, u) => f === current && setUrl(u));
    const offExit = api.folderTerminal.onExit((f) => {
      if (f !== current) return;
      setExited(true);
      setStarting(null);
    });
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
        {url ? <span>{t('本機網站在跑：')}<code>{url}</code></span> : <span className="muted">{t('本機網站沒有在跑')}</span>}
      </div>
      <div className="row">
        {url ? (
          <>
            <button className="primary" onClick={() => api.openUrl(url).catch((e) => setError(errorText(e)))}>{t('打開網頁')}</button>
            <button
              title={t('在對話框掛上「看你開的畫面」，打你要 AI 看什麼再送出。Chrome 要先裝 Playwright 擴充功能')}
              // 不直接叫 AI 做事：先讓你在對話框說要它看什麼，送出時才一起交給 AI
              onClick={() => window.dispatchEvent(new CustomEvent('flowpilot:look', { detail: item.id }))}
            >
              {t('看我的')}
            </button>
            <button onClick={() => folder && api.folderTerminal.interrupt(folder)}>{t('停止')}</button>
          </>
        ) : (
          <button
            className="primary"
            disabled={starting !== null}
            onClick={() => {
              setStarting(Date.now());
              setNow(Date.now());
              setLastLine('');
              api.folderTerminal.startSite(item.id).catch((e) => {
                setStarting(null);
                setError(errorText(e));
              });
            }}
          >
            {starting !== null ? t('啟動中…') : t('啟動')}
          </button>
        )}
        {/* 終端機是開發者的工具，平常收起來；真的需要時再打開 */}
        <button className="link small push-right" onClick={() => setShowTerminal(!showTerminal)}>{showTerminal ? t('收起終端機') : t('顯示終端機')}</button>
      </div>

      {starting !== null && !url && (
        <div className="site-starting">
          <span className="spinner" />
          <span>{t('啟動中，第一次編譯大約要 30 秒到 1 分鐘（已經 {seconds} 秒）', { seconds: Math.round((now - starting) / 1000) })}</span>
          {lastLine && <code className="site-last-line" title={lastLine}>{lastLine}</code>}
        </div>
      )}
      <p className="muted small">
        {t('「打開網頁」用你平常的 Chrome 開。要讓 AI 看得到你開的頁面，Chrome 要先裝 Playwright 官方的擴充功能')}
        <button className="link small" onClick={() => api.openExternal('https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm')}>{t('（安裝）')}</button>
        {t('；之後按「看我的」、在對話框打你要它看什麼，送出後 Chrome 會跳出頁面讓你選要給 AI 的分頁。')}
      </p>
      <div ref={host} className="folder-term" style={showTerminal ? undefined : { display: 'none' }} />
      {exited && <div className="muted small">{t('終端機已結束，切換到別張單再切回來會重新打開。')}</div>}
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
  if (!state || !delivery) return <div className="panel"><p className="muted small">{t('讀取中…')}</p>{!!loadError && <div className="error">{errorText(loadError)}</div>}</div>;

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
    ? t('資料夾目前在 {current}，不是這張單的分支 {branch}', { current: state.branch, branch: item.branch })
    : changes.length
      ? aiWorking ? t('AI 還在改，做完之後用上方的「提交」按鈕提交') : t('確認沒問題後，用上方的「提交」按鈕提交')
      : pushCount > 0
        ? t('有 {count} 個提交還沒推送，用上方的「推送」按鈕推送', { count: pushCount })
        : state.hasRemote && state.ahead > 0 ? t('改動都已推送到遠端') : '';

  return (
    <div className="panel git">
      <div className="panel-head">
        <span className="muted small">{t('分支')}</span>
        <code className="small">{state.branch || t('（不在分支上）')}</code>
      </div>
      {(error || !!loadError) && <div className="error">{error ?? errorText(loadError)}</div>}
      {status && <p className="muted small git-status">{status}</p>}

      <div className="git-section">
        <div className="git-section-head"><span>{onBranch ? t('還沒提交的改動（{count} 個檔案）', { count: changes.length }) : t('資料夾裡沒提交的改動（{count} 個檔案，在 {current} 上，不是這張單的）', { count: changes.length, current: state.branch || t('（不在任何分支）') })}</span></div>
        {changes.length === 0 && <p className="muted small">{pushCount > 0 || state.ahead > 0 ? t('改動都提交了。') : t('目前沒有改動。')}</p>}
        <ul className="git-files">
          {changes.map((file) => <FileRow key={file.path} file={file} diff={diff?.path === file.path ? diff.text : null} onClick={() => showDiff(file)} />)}
        </ul>
        {testOnly.length > 0 && <p className="muted small">{t('environment.ts 是測試時切環境改的，不會提交；完成這張單時會還原。')}</p>}
      </div>

      {changes.length > 0 && onBranch && (
        <div className="git-commit">
          <button className="link small" onClick={() => setEditing(!editing)}>{editing ? t('收起') : t('修改提交訊息')}</button>
          {editing && (
            <>
              <input
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setCommitPrefs(item.id, { message: e.target.value });
                }}
                placeholder={t('提交訊息')}
              />
              {identityOptions.length > 1 && (
                <label className="identity">
                  <span className="muted small">{t('提交身分（只套用在這一次）')}</span>
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
                        {i.name} &lt;{i.email}&gt;{i.email === state.identity.email ? t('（預設）') : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}

      <BranchCommitsPanel item={item} refreshKey={`${state.branch}-${state.ahead}-${state.unpushed}`} />
    </div>
  );
}

/** 改動的一個檔案：點檔名看改了什麼；覺得不對就「要 AI 改」 */
function FileRow({ file, diff, onClick }: { file: GitFile; diff: string | null; onClick(): void }) {
  const name = file.path.split('/').pop();
  return (
    <li className={diff !== null ? 'open' : ''}>
      <button className="file-name" onClick={onClick} title={t('{path}（點一下看改了什麼）', { path: file.path })}>
        <span className={`code c-${file.code}`}>{CHANGE_LABEL[file.code] ? t(CHANGE_LABEL[file.code]) : t('修改')}</span> {name} <span className="muted small">{file.path.slice(0, file.path.length - (name?.length ?? 0))}</span>
      </button>
      <button
        className="link small file-actions"
        title={t('這個檔案改得不對？按一下會把檔名帶進中間的輸入框，接著打要怎麼改，送出給 AI')}
        onClick={() => window.dispatchEvent(new CustomEvent('flowpilot:ask-ai', { detail: t('{path}：', { path: file.path }) }))}
      >
        {t('要 AI 改')}
      </button>
      {diff !== null && <div className="diff-row"><DiffView diff={diff} /></div>}
    </li>
  );
}

function shortTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 這條分支的提交：比基底多出來的提交，最新的在上面。點提交看那次改了哪些檔案、點檔名看改了什麼；
 * 最上面一列「全部合計」是整條分支跟基底比。唯讀；待補測、已完成的單沒有資料夾也看得到（讀本機的分支或遠端）。
 */
export function BranchCommitsPanel({ item, refreshKey }: { item: WorkItem; refreshKey?: string }) {
  const [data, setData] = useState<BranchCommits | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 展開的是哪一列：'all' 是全部合計，其他是提交編號 */
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, GitFile[]>>({});
  const [diff, setDiff] = useState<{ row: string; path: string; text: string } | null>(null);

  useEffect(() => {
    api.git
      .commits(item.id)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  }, [item.id, item.status, refreshKey]);

  async function toggle(row: string) {
    setDiff(null);
    if (open === row) return setOpen(null);
    setOpen(row);
    if (row === 'all' || files[row]) return;
    try {
      const list = await api.git.commitFiles(item.id, row);
      setFiles((prev) => ({ ...prev, [row]: list }));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function showDiff(row: string, path: string) {
    if (diff?.row === row && diff.path === path) return setDiff(null);
    try {
      setDiff({ row, path, text: await api.git.commitDiff(item.id, row === 'all' ? null : row, path) });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const fileList = (row: string, list: GitFile[] | undefined) =>
    !list ? <p className="muted small">{t('讀取中…')}</p> : (
      <ul className="git-files">
        {list.map((file) => <FileRow key={file.path} file={file} diff={diff?.row === row && diff.path === file.path ? diff.text : null} onClick={() => showDiff(row, file.path)} />)}
      </ul>
    );

  const merged = item.prs.some((p) => p.status === 'completed');
  return (
    <div className="git-section branch-commits">
      <div className="git-section-head">
        <span>{data ? t('這條分支的提交（{count} 個）', { count: data.total }) : t('這條分支的提交')}</span>
        {data && <span className="muted small">{t('跟 {base} 比', { base: data.base })}{data.where === zhOnly('遠端') ? t('（讀遠端的分支）') : ''}</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="muted small">{t('讀取中…')}</p>}
      {data && data.commits.length === 0 && (
        <p className="muted small">{merged ? t('這條分支的提交都已經合併進 {base}。', { base: data.base }) : t('還沒有提交。')}</p>
      )}
      {data && data.commits.length > 0 && (
        <ul className="commit-list">
          <li className={open === 'all' ? 'open' : ''}>
            <button className="commit-row" onClick={() => toggle('all')} title={t('整條分支跟 {base} 比，總共改了哪些檔案', { base: data.base })}>
              <span className="caret">{open === 'all' ? '▾' : '▸'}</span>
              <strong>{t('全部合計')}</strong>
              <span className="muted small">{t('{count} 個檔案', { count: data.files.length })}</span>
            </button>
            {open === 'all' && fileList('all', data.files)}
          </li>
          {data.commits.map((c) => (
            <li key={c.sha} className={open === c.sha ? 'open' : ''}>
              <button className="commit-row" onClick={() => toggle(c.sha)} title={t('{sha}（點一下看這次改了哪些檔案）', { sha: c.sha.slice(0, 8) })}>
                <span className="caret">{open === c.sha ? '▾' : '▸'}</span>
                <span className="commit-subject">{c.subject}</span>
                <span className="muted small">{shortTime(c.date)}</span>
                <span className={`commit-push ${c.pushed ? 'pushed' : 'local'}`}>{c.pushed ? t('已推送') : t('未推送')}</span>
              </button>
              {open === c.sha && fileList(c.sha, files[c.sha])}
            </li>
          ))}
          {data.total > data.commits.length && <li className="muted small">{t('只列最近 {count} 個', { count: data.commits.length })}</li>}
        </ul>
      )}
    </div>
  );
}

/** Git 的代號換成操作者看得懂的字 */
// i18n-keys：顯示時才翻
const CHANGE_LABEL: Record<string, string> = { M: '修改', A: '新增', U: '新增', D: '刪除', R: '改名', C: '複製' };


/** 驗收截圖：AI 測試時截的「應該長這樣」，點一下放大 */
function AcceptanceShot({ name }: { name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let alive = true;
    api.test.shot(name).then((url) => alive && setSrc(url)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);
  if (!src) return null;
  return (
    <figure className={`ac-shot ${big ? 'big' : ''}`} onClick={() => setBig(!big)} title={big ? t('縮小') : t('放大')}>
      <img src={src} alt={t('應該長這樣')} />
      <figcaption className="muted small">{t('AI 測試時的畫面（應該長這樣）')}</figcaption>
    </figure>
  );
}
