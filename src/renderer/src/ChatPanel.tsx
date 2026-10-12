// 工作台中間：跟 AI 對話。完整的對話紀錄（思考、指令、改動、工具）、即時更新、輸入框（可貼截圖）。
import { useEffect, useRef, useState } from 'react';
import type { BranchInfo, ChatEntry, ChatEvent, WorkItem, WorkStage, WorkStatus } from '../../shared/types';
import { DiffView } from './DiffView';
import { commitPrefs, deliveryOf, gitChanged, useGitState } from './delivery';
import { Markdown } from './Markdown';
import { pendingChecks } from './SidePanels';
import { statusLabel, term } from './skin';

const api = window.flowpilot;

/** 狀態文字（開了指揮官用語會換成作戰用語） */
export const STATUS_LABEL = new Proxy({} as Record<WorkStatus, string>, { get: (_t, key) => statusLabel(key as WorkStatus) });

/** 跟狀態標籤意思一樣的說明，不重複顯示 */
const REDUNDANT_ACTIVITY = /^(AI 在問你問題|執行中|執行技能|開發中|AI 做完了，等你審查|已完成)$/;

/** 流程：審閱 ✓ → 開發 → 自動測試 → 等你測試（修改、重測都算在等你測試這一步）→ 交付（提交過之後：推送、完成） */
const STEPS = ['審閱', '開發', '自動測試', '等你測試', '交付'];
const STEP_OF: Record<WorkStage, number> = { develop: 1, selfcheck: 1, autotest: 2, manual: 3, fix: 3, retest: 3 };
const RUNNING_NOTE: Record<WorkStage, string> = { develop: 'AI 開發中', selfcheck: 'AI 自我審查中', autotest: 'AI 測試中', manual: 'AI 處理中', fix: 'AI 修改中', retest: 'AI 重測中' };

/** 目前這一步在等什麼（合併原本的狀態標籤）；空字串代表不用多說明 */
function stepNote(item: WorkItem): string {
  switch (item.status) {
    case 'running':
      return RUNNING_NOTE[item.stage];
    case 'waiting':
      return item.pending?.kind === 'approval' ? '等你同意' : item.pending?.kind === 'decision' ? '等你決定' : '要你回答';
    case 'review':
      return '';
    default:
      return STATUS_LABEL[item.status];
  }
}

function Stages({ item, delivering }: { item: WorkItem; delivering: boolean }) {
  const current = delivering && item.stage === 'manual' ? 4 : STEP_OF[item.stage] ?? 1;
  const finished = item.status === 'committed';
  const note = stepNote(item);
  const tone = ['waiting', 'blocked'].includes(item.status) ? 'attn' : ['failed', 'stopped'].includes(item.status) ? 'bad' : '';
  return (
    <ol className="stages">
      {STEPS.map((label, i) => {
        const done = finished || i < current;
        const now = !finished && i === current;
        // 自動測試：照結果顯示，沒測成、部分通過、看不出來都不打勾；沒跑過（舊單）顯示略過
        const result = done && i === 2 ? autotestMark(item) : null;
        return (
          <li key={label} className={result ? result.className : done ? 'done' : now ? `now ${tone}` : ''} title={result?.title}>
            {term(label)}
            {result ? result.text : done ? ' ✓' : ''}
            {now && (i === 4 && item.status === 'review' ? <span className="step-note">・推送、完成</span> : note && <span className="step-note">・{note}</span>)}
          </li>
        );
      })}
    </ol>
  );
}

/** 自動測試那一格怎麼顯示 */
function autotestMark(item: WorkItem): { text: string; className: string; title?: string } | null {
  const r = item.autotestResult;
  if (!r) return item.autotested ? null : { text: '（略過）', className: 'skipped' };
  if (r.kind === 'passed') return null; // 照一般的打勾
  if (r.kind === 'partial') return { text: '（部分通過）', className: 'partial', title: r.reason };
  if (r.kind === 'failed') return { text: '（沒測成）', className: 'failed', title: r.reason };
  return { text: '（看結果）', className: 'partial', title: '測試的 AI 沒有寫出結果，請看對話裡最後的報告' };
}

/** FlowPilot 自動交給 AI 的訊息（開發、測試指示、更新需求），不是你打的字 */
function flowPilotLabel(text: string): string | null {
  const skill = text.match(/^［技能：(.+?)］/)?.[1];
  if (skill) {
    const kind = text.includes('開瀏覽器重新測試') ? '重測指示' : text.includes('自動安排的測試') ? '自動測試指示' : text.includes('移植到商戶') ? '移植指示' : '開發指示';
    return `${kind}（${skill}）`;
  }
  if (text.startsWith('## 更新需求')) return '更新需求';
  if (text.startsWith('## 自我審查')) return '自我審查指示';
  if (text.startsWith('## 整理驗收表')) return '整理驗收表指示';
  if (text.trim() === '請從剛才中斷的地方繼續。') return '請 AI 從中斷的地方繼續';
  return null;
}

/**
 * 移除的確認視窗：移除就是回到從沒做過的樣子——刪本機分支（遠端不動）、資料夾還原、審閱紀錄刪掉。
 * 會遺失的東西（沒推送的提交、沒提交的改動）用紅字列出來，你確定才移除。
 */
function RemoveDialog({ item, onClose }: { item: WorkItem; onClose(): void }) {
  const [info, setInfo] = useState<BranchInfo | null | undefined>(item.folder ? undefined : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = ['running', 'preparing'].includes(item.status);

  useEffect(() => {
    if (item.folder) api.branchInfo(item.id).then(setInfo).catch((e) => (setInfo(null), setError(`讀不到分支狀況：${errorText(e)}`)));
  }, [item.id]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.remove(item.id);
      if (info?.exists && !result.branchDeleted) window.alert(`已從工作台移除 ${item.ticketKey}，但本機分支沒有刪成：${result.reason ?? '原因不明'}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>從工作台移除 {item.ticketKey}？</h3>
        <p className="muted small">
          {item.project}{item.merchant ? ` m${item.merchant}` : ''} · <code>{item.branch}</code>
        </p>
        {running ? (
          <p className="warn small">AI 還在執行，請先按「中斷這一輪」，停下來之後再移除。</p>
        ) : (
          <>
            <p className="small">移除就是回到從沒做過的樣子：</p>
            <ul className="modal-notes small">
              {info?.exists && <li>刪掉本機分支 <code>{info.branch}</code>；{item.folder} 停在這條分支上的話，會切回 {info.baseBranch}。</li>}
              <li><strong>遠端分支不會動</strong>{info?.hasRemote ? '（遠端有這條分支，要刪請你自己刪）' : ''}。</li>
              <li>審閱紀錄刪掉，單列表上的標籤也會消失；要重新做，從單列表再選一次。</li>
            </ul>
            {info === undefined && <p className="muted small">讀取分支狀況中…</p>}
            {info && (info.unpushed === null || info.unpushed > 0 || info.dirty.length > 0) && (
              <ul className="modal-notes small">
                {info.unpushed === null && <li className="danger-text">算不出有幾個提交還沒推送；移除後，這些提交可能就沒了。</li>}
                {!!info.unpushed && <li className="danger-text">有 {info.unpushed} 個提交還沒推送，移除後就沒了。</li>}
                {info.dirty.length > 0 && (
                  <li className="danger-text">
                    有 {info.dirty.length} 個沒提交的改動會被丟掉：{info.dirty.slice(0, 5).join('、')}{info.dirty.length > 5 ? ' 等' : ''}
                  </li>
                )}
              </ul>
            )}
          </>
        )}
        {error && <div className="error small">{error}</div>}
        <div className="row modal-actions">
          <button disabled={busy} onClick={onClose}>取消</button>
          <button className="danger-solid" disabled={busy || running || info === undefined} onClick={confirm}>
            {busy ? '處理中…' : '移除'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

/** 把即時更新套到對話紀錄上 */
function applyEvent(entries: ChatEntry[], event: ChatEvent): ChatEntry[] {
  if (event.type === 'upsert') {
    const index = entries.findIndex((e) => e.id === event.entry.id);
    if (index === -1) return [...entries, event.entry];
    const next = [...entries];
    // 完成時的內容比較完整；但如果完成事件沒有帶文字，保留即時累積的內容
    const merged = { ...next[index], ...event.entry };
    if (!event.entry.text && next[index].text) merged.text = next[index].text;
    if (!event.entry.output && next[index].output) merged.output = next[index].output;
    next[index] = merged;
    return next;
  }
  const index = entries.findIndex((e) => e.id === event.id);
  if (index === -1) {
    // 還沒收到開始的事件：先建一則（AI 回覆最常見）
    return [...entries, { id: event.id, kind: event.field === 'output' ? 'command' : 'assistant', text: event.field === 'text' ? event.delta : '', output: event.field === 'output' ? event.delta : undefined }];
  }
  const next = [...entries];
  const entry = { ...next[index] };
  if (event.field === 'text') entry.text = (entry.text ?? '') + event.delta;
  else entry.output = (entry.output ?? '') + event.delta;
  next[index] = entry;
  return next;
}

function Collapsible({ title, children, open = false, tone = '' }: { title: React.ReactNode; children: React.ReactNode; open?: boolean; tone?: string }) {
  const [expanded, setExpanded] = useState(open);
  return (
    <div className={`fold ${tone}`}>
      <button className="fold-head" onClick={() => setExpanded(!expanded)}>
        <span className="fold-arrow">{expanded ? '▾' : '▸'}</span> {title}
      </button>
      {expanded && <div className="fold-body">{children}</div>}
    </div>
  );
}

function Entry({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case 'user': {
      const label = flowPilotLabel(entry.text);
      if (label)
        return (
          <Collapsible title={<span><span className="fp-tag">FlowPilot</span> 交給 AI 的{label}</span>} tone="soft flowpilot">
            <Markdown text={entry.text} />
          </Collapsible>
        );
      return (
        <div className="msg user">
          <Markdown text={entry.text} />
          {!!entry.images?.length && <div className="muted small">附上 {entry.images.length} 張截圖</div>}
        </div>
      );
    }
    case 'assistant':
      return (
        <div className="msg assistant">
          {/* 驗收表的 JSON 畫在右邊「驗收」，對話裡只留一句 */}
          <Markdown text={entry.text.replace(/```flowpilot-test[\s\S]*?(```|$)/g, '_（驗收表已更新，看右邊「驗收」）_')} />
        </div>
      );
    case 'reasoning':
      return entry.text ? (
        <Collapsible title={<span className="muted">思考</span>} tone="soft">
          <Markdown text={entry.text} className="muted" />
        </Collapsible>
      ) : null;
    case 'plan':
      return (
        <Collapsible title="計畫" open tone="soft">
          <Markdown text={entry.text} />
        </Collapsible>
      );
    case 'command': {
      const failed = entry.status === 'failed' || (entry.exitCode ?? 0) !== 0;
      const running = entry.status === 'inProgress';
      return (
        <Collapsible
          tone={failed && !running ? 'bad' : ''}
          title={
            <span>
              <span className="muted">{running ? '執行中' : failed ? `失敗（${entry.exitCode ?? '—'}）` : '執行'}</span> <code>{(entry.command ?? '').replace(/^\/bin\/zsh -lc /, '')}</code>
            </span>
          }
        >
          <pre className="output">{entry.output || '（沒有輸出）'}</pre>
        </Collapsible>
      );
    }
    case 'fileChange':
      return (
        <Collapsible title={<span>改了 {entry.files?.length ?? 0} 個檔案{entry.status === 'declined' ? '（被拒絕）' : ''}</span>} open>
          {(entry.files ?? []).map((f) => (
            <Collapsible key={f.path} title={<code>{f.path}</code>} tone="soft">
              <DiffView diff={f.diff} />
            </Collapsible>
          ))}
        </Collapsible>
      );
    case 'tool':
      return (
        <Collapsible title={<span><span className="muted">工具</span> {entry.text}</span>} tone={entry.status === 'failed' ? 'bad' : ''}>
          <pre className="output">{entry.output || '（沒有輸出）'}</pre>
        </Collapsible>
      );
    case 'search':
      return <div className="muted small">搜尋：{entry.text}</div>;
    default:
      return <div className="muted small">— {entry.text} —</div>;
  }
}

export function ChatPanel({ item }: { item: WorkItem }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  // 右邊「改動」的「跟 AI 說」：把檔名帶進輸入框，接著打要怎麼改
  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setText((prev) => (prev.trim() ? `${prev}\n${detail}` : detail));
      setTimeout(() => input.current?.focus(), 0);
    };
    window.addEventListener('flowpilot:ask-ai', onAsk);
    return () => window.removeEventListener('flowpilot:ask-ai', onAsk);
  }, []);

  // 讀完整紀錄；讀取期間收到的即時更新先暫存，讀完再套上
  useEffect(() => {
    let cancelled = false;
    let pending: ChatEvent[] = [];
    let loaded = false;
    setEntries([]);
    setError(null);
    stick.current = true;
    const off = api.onChat((id, event) => {
      if (id !== item.id) return;
      if (!loaded) pending.push(event);
      else setEntries((prev) => applyEvent(prev, event));
    });
    if (item.threadId) {
      setLoading(true);
      api
        .chatHistory(item.id)
        .then((history) => {
          if (cancelled) return;
          loaded = true;
          setEntries(pending.reduce(applyEvent, history));
          pending = [];
        })
        .catch((e) => !cancelled && setError(`讀取對話紀錄失敗：${errorText(e)}`))
        .finally(() => !cancelled && setLoading(false));
    } else {
      loaded = true;
    }
    return () => {
      cancelled = true;
      off();
    };
  }, [item.id, item.threadId]);

  useEffect(() => {
    const box = scroller.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [entries, item.pending]);

  // 「已提交」這類回饋幾秒後自動消失
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!text.trim() && images.length === 0) return;
    const message = text;
    const attached = images;
    await act(async () => {
      await api.send(item.id, message, attached);
      setText('');
      setImages([]);
      stick.current = true;
    });
  }

  async function onPaste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      const path = await api.saveImage(await file.arrayBuffer(), file.type.split('/')[1] ?? 'png');
      setImages((prev) => [...prev, path]);
    }
  }

  const running = item.status === 'running';

  async function finish() {
    // 還有提交沒推送就先提醒（照平常的流程，推送後才算完成）
    let unpushed = 0;
    try {
      const git = await api.git.state(item.id);
      unpushed = git.hasRemote ? (git.unpushed ?? 0) : git.ahead;
    } catch {}
    const pending = pendingChecks(item);
    const warning =
      (unpushed > 0 ? `\n\n⚠️ 還有 ${unpushed} 個提交沒推送。完成之後還是可以推送，但要記得。` : '') +
      (pending ? `\n\n⚠️ 驗收表還有 ${pending} 項要你測、還沒勾「我測過了」。` : '');
    const ok = window.confirm(
      `完成 ${item.ticketKey}，讓出 ${item.folder} 給下一張？${warning}\n\n資料夾要乾淨（改動都提交或捨棄了）；environment.ts（瀏覽器測試切 SIT／UAT 用的）會順便還原，本機網站也會停掉。`,
    );
    if (ok) act(() => api.finish(item.id, true));
  }
  const active = !['committed', 'removed'].includes(item.status);
  // 交付：標題列的主要按鈕照進度變成「提交 → 推送 → 完成這張單」
  const { state: git } = useGitState(item, active && !!item.threadId);
  const delivery = deliveryOf(item, git);
  const canDeliver = active && !!item.folder && !!item.threadId && ['review', 'waiting'].includes(item.status) && !item.pending?.kind?.match(/approval|decision/);
  let next: { label: string; title?: string; run(): void } | null = null;
  if (canDeliver && delivery?.onBranch && git) {
    if (delivery.changes.length) {
      next = {
        label: busy ? '提交中…' : `提交 ${delivery.changes.length} 個檔案`,
        title: '把 AI 的改動提交到這張單的分支（專案的提交前檢查可能要等幾十秒）；提交訊息可以在右邊「改動」修改',
        run: () => act(async () => {
          const prefs = commitPrefs(item.id);
          const result = await api.git.commitAll(item.id, prefs.message ?? item.prTitle, prefs.who ?? undefined);
          gitChanged();
          setNotice(`已提交（${result.sha}）${result.restored.length ? `；提交前檢查順手改到的 ${result.restored.length} 個無關檔案已還原` : ''}`);
        }),
      };
    } else if (delivery.pushCount > 0) {
      const count = delivery.pushCount;
      next = {
        label: busy ? '推送中…' : git.needsForce ? `強制推送 ${count} 個提交` : `推送 ${count} 個提交`,
        title: git.needsForce ? '分支 rebase 過，跟遠端的歷史不一樣，會用 --force-with-lease 推送' : git.hasRemote ? undefined : '遠端還沒有這條分支，推送時會建立',
        run: () => {
          const what = git.needsForce
            ? `遠端的 ${item.branch} 跟本機的歷史不一樣（rebase 過），要強制推送嗎？\n\n會用 --force-with-lease：遠端被別人推了新的提交時會拒絕覆蓋。`
            : `推送 ${count} 個提交到遠端的 ${item.branch}${git.hasRemote ? '' : '（建立遠端分支）'}？`;
          if (window.confirm(what)) act(async () => {
            await api.git.push(item.id);
            gitChanged();
            setNotice('已推送');
          });
        },
      };
    } else if (item.status === 'review') {
      next = { label: '完成這張單', run: finish };
    }
  } else if (item.status === 'review' && item.folder) {
    next = { label: '完成這張單', run: finish };
  }
  // 自動測試沒測成或看不出結果時，處理好之後可以再跑一次
  const canRerun = active && !!item.threadId && item.stage === 'manual' && ['review', 'waiting'].includes(item.status) && !item.pending && !!item.autotestResult && item.autotestResult.kind !== 'passed';
  const canRetest = active && !!item.threadId && item.stage === 'manual' && ['review', 'waiting'].includes(item.status) && !item.pending;
  // AI 在等你回話（問問題、被中斷、或有事要你處理）：輸入框加醒目外框
  const awaitingYou = item.status === 'waiting' && (!item.pending || item.pending.kind === 'userInput');
  const canSend = !!item.threadId && active && !['queued', 'preparing'].includes(item.status) && item.pending?.kind !== 'approval' && item.pending?.kind !== 'decision';

  return (
    <section className="chat">
      {removing && <RemoveDialog item={item} onClose={() => setRemoving(false)} />}
      <div className="chat-head">
        <div className="chat-head-top">
        <div className="chat-title">
          {/* 開始對話前沒有階段可看，才顯示狀態 */}
          {!item.threadId && <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>}
          <strong>{item.ticketKey}</strong>
          <span className="item-title" title={item.ticketSummary}>{item.ticketSummary}</span>
        </div>
        <div className="row head-actions">
          {running && <button disabled={busy} onClick={() => act(() => api.interrupt(item.id))}>中斷這一輪</button>}
          {canRetest && !delivery?.delivering && (
            <button
              disabled={busy}
              title="AI 先列測試計畫給你確認，再開瀏覽器測給你看（用測試帳號自動登入）"
              onClick={() => act(async () => {
                stick.current = true;
                await api.retest(item.id);
              })}
            >
              開瀏覽器測給我看
            </button>
          )}
          {next && (
            <button className="primary" disabled={busy} onClick={next.run} title={next.title}>
              {next.label}
            </button>
          )}
          {['blocked', 'failed', 'stopped'].includes(item.status) && <button disabled={busy} onClick={() => act(() => api.retry(item.id))}>重試</button>}
          {item.status !== 'removed' && (
            <details className="more">
              <summary>更多</summary>
              <div className="more-menu">
                {canRerun && (
                  <button
                    disabled={busy}
                    title="用無頭瀏覽器再跑一次自動測試（例如處理好帳號、開了 VPN 之後）"
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.rerunAutotest(item.id);
                      });
                    }}
                  >
                    重跑自動測試
                  </button>
                )}
                {canRetest && delivery?.delivering && (
                  <button
                    disabled={busy}
                    title="AI 先列測試計畫給你確認，再開瀏覽器測給你看（用測試帳號自動登入）"
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.retest(item.id);
                      });
                    }}
                  >
                    開瀏覽器測給我看
                  </button>
                )}
                {active && item.threadId && (
                  <button
                    disabled={busy || running}
                    title={running ? 'AI 執行中，等它停下來再更新需求' : '重新讀 Jira，跟上次的內容比對，請 AI 在對話裡說明有沒有變更、打算怎麼改'}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.requestRequirementUpdate(item.id);
                      });
                    }}
                  >
                    更新需求
                  </button>
                )}
                {active && item.threadId && item.folder && <button onClick={() => act(() => api.openInVSCode(item.id))}>在 VS Code 查看</button>}
                {active && item.status !== 'review' && !running && item.status !== 'preparing' && item.folder && <button onClick={finish}>完成這張單</button>}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open'); // 收起「更多」選單
                    setRemoving(true);
                  }}
                >
                  移除
                </button>
              </div>
            </details>
          )}
        </div>
        </div>
        <div className="chat-head-sub">
          <div className="muted small head-meta">
            {item.project}{item.merchant ? ` m${item.merchant}` : ''}
            {/* 資料夾跟專案同名就不重複寫 */}
            {item.folder !== item.project && <> · {item.folder ?? '等資料夾'}</>} · <code>{item.branch}</code>
            {item.activity && !REDUNDANT_ACTIVITY.test(item.activity) && <> · {item.activity}</>}
          </div>
          {item.threadId && <Stages item={item} delivering={!!delivery?.delivering} />}
        </div>
      </div>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const box = e.currentTarget;
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        }}
      >
        {loading && <p className="muted small">讀取對話紀錄中…</p>}
        {!item.threadId && <p className="muted">{item.activity || '還沒開始跟 AI 對話。'}</p>}
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
        {running && <div className="muted small typing">AI 工作中…</div>}

        {item.pending?.kind === 'approval' && (
          <div className="pending">
            <div>
              AI 要執行<strong>{item.pending.reason}</strong>的指令：
            </div>
            <code className="command">{item.pending.command}</code>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => act(() => api.approve(item.id, true))}>同意</button>
              <button disabled={busy} onClick={() => act(() => api.approve(item.id, false))}>拒絕</button>
            </div>
          </div>
        )}
        {item.pending?.kind === 'decision' && (
          <div className="pending">
            <div>{item.pending.question}</div>
            <div className="row">
              {item.pending.options.map((option, index) => (
                <button key={option.id} className={index === 0 ? 'primary' : ''} disabled={busy} onClick={() => act(() => api.decide(item.id, option.id))}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {item.pending?.kind === 'userInput' && (
          <div className="pending">
            {item.pending.questions.map((q) => (
              <div key={q.id}>
                <strong>{q.header}</strong> {q.question}
                {q.options.length > 0 && <div className="muted">選項：{q.options.join('／')}</div>}
              </div>
            ))}
            <div className="muted small">在下面的輸入框回答。</div>
          </div>
        )}
      </div>

      {notice && <div className="notice-ok">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {canSend && (
        <div className={`composer ${awaitingYou ? 'attention' : ''}`}>
          {images.length > 0 && (
            <div className="attachments">
              {images.map((path) => (
                <span key={path} className="chip on">
                  截圖 {path.split('/').pop()?.slice(0, 8)}
                  <button className="link" onClick={() => setImages((prev) => prev.filter((p) => p !== path))}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            rows={3}
            value={text}
            placeholder={
              running ? '補充指示（會插進正在進行的這一輪，Enter 送出，Shift＋Enter 換行）。可以直接貼上截圖。'
              : awaitingYou ? 'AI 在等你回答…（Enter 送出，Shift＋Enter 換行，可以直接貼上截圖）'
              : '跟 AI 說…（Enter 送出，Shift＋Enter 換行，可以直接貼上截圖）'
            }
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Enter 送出、Shift＋Enter 換行；中文輸入法選字時按的 Enter 不算
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="row composer-actions">
            <button className="primary" disabled={busy || (!text.trim() && images.length === 0)} onClick={send}>
              送出
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
