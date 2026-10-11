// 工作台中間：跟 AI 對話。完整的對話紀錄（思考、指令、改動、工具）、即時更新、輸入框（可貼截圖）。
import { useEffect, useRef, useState } from 'react';
import type { BranchInfo, ChatEntry, ChatEvent, WorkItem, WorkStage, WorkStatus } from '../../shared/types';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';

const api = window.flowpilot;

export const STATUS_LABEL: Record<WorkStatus, string> = {
  queued: '排隊中',
  preparing: '準備中',
  running: '執行中',
  waiting: '等你回答',
  review: '等你測試',
  blocked: '卡住了',
  failed: '失敗',
  stopped: '已停止',
  removed: '已移除',
  committed: '已完成',
};

/** 跟狀態標籤意思一樣的說明，不重複顯示 */
const REDUNDANT_ACTIVITY = /^(AI 在問你問題|執行中|執行技能|開發中|AI 做完了，等你審查|已完成)$/;

/** 流程：審閱 ✓ → 開發 → 自動測試 → 等你測試（修改、重測都算在等你測試這一步） */
const STEPS = ['審閱', '開發', '自動測試', '等你測試'];
const STEP_OF: Record<WorkStage, number> = { develop: 1, autotest: 2, manual: 3, fix: 3, retest: 3 };
const RUNNING_NOTE: Record<WorkStage, string> = { develop: 'AI 開發中', autotest: 'AI 測試中', manual: 'AI 處理中', fix: 'AI 修改中', retest: 'AI 重測中' };

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

function Stages({ item }: { item: WorkItem }) {
  const current = STEP_OF[item.stage] ?? 1;
  const finished = item.status === 'committed';
  const note = stepNote(item);
  const tone = ['waiting', 'blocked'].includes(item.status) ? 'attn' : ['failed', 'stopped'].includes(item.status) ? 'bad' : '';
  return (
    <ol className="stages">
      {STEPS.map((label, i) => {
        const done = finished || i < current;
        const now = !finished && i === current;
        // 自動測試沒有真的跑過（舊單、或缺帳號沒辦法開始）就不打勾
        const skipped = done && i === 2 && !item.autotested;
        return (
          <li key={label} className={skipped ? 'skipped' : done ? 'done' : now ? `now ${tone}` : ''}>
            {label}
            {skipped ? '（略過）' : done ? ' ✓' : ''}
            {now && note && <span className="step-note">・{note}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** FlowPilot 自動交給 AI 的訊息（開發、測試指示、更新需求），不是你打的字 */
function flowPilotLabel(text: string): string | null {
  const skill = text.match(/^［技能：(.+?)］/)?.[1];
  if (skill) {
    const kind = text.includes('開瀏覽器重新測試') ? '重測指示' : text.includes('自動安排的測試') ? '自動測試指示' : '開發指示';
    return `${kind}（${skill}）`;
  }
  if (text.startsWith('## 更新需求')) return '更新需求';
  if (text.trim() === '請從剛才中斷的地方繼續。') return '請 AI 從中斷的地方繼續';
  return null;
}

/**
 * 移除的確認視窗：可以勾選同時刪除本機分支（預設不勾）。
 * 勾了會列出刪掉會失去什麼：只在本機的提交、遠端有沒有、沒提交的修改（有的話不刪）。
 */
function RemoveDialog({ item, onClose }: { item: WorkItem; onClose(): void }) {
  const [info, setInfo] = useState<BranchInfo | null | undefined>(undefined);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = ['running', 'preparing'].includes(item.status);

  useEffect(() => {
    api.branchInfo(item.id).then(setInfo).catch((e) => (setInfo(null), setError(`讀不到分支狀況：${errorText(e)}`)));
  }, [item.id]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.remove(item.id, deleteBranch);
      if (deleteBranch && !result.branchDeleted) window.alert(`已從工作台移除 ${item.ticketKey}，但分支沒有刪：${result.reason ?? '原因不明'}`);
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
        <ul className="modal-notes small">
          {running && <li>AI 正在執行，會先中斷它。</li>}
          <li>移除後沒辦法從 FlowPilot 叫回來；要重新做，到「單列表」再確認一次計畫。</li>
          {!deleteBranch && <li>不會動到 {item.folder ?? '資料夾'} 裡的檔案或分支。</li>}
        </ul>

        {info === undefined && item.folder && <p className="muted small">讀取分支狀況中…</p>}
        {info?.exists && (
          <label className={`modal-check ${running ? 'disabled' : ''}`}>
            <input type="checkbox" checked={deleteBranch} disabled={running || busy} onChange={(e) => setDeleteBranch(e.target.checked)} />
            同時刪除本機分支 <code>{info.branch}</code>
            {running && <span className="muted small">（AI 執行中不能刪，請先中斷）</span>}
          </label>
        )}
        {info && !info.exists && <p className="muted small">本機沒有 {info.branch}，不用刪。</p>}

        {deleteBranch && info && (
          <ul className="modal-notes small">
            {info.unpushed === null ? (
              <li className="danger-text">算不出有幾個提交只在這台電腦上；刪掉的話，這些提交可能就沒了。</li>
            ) : info.unpushed > 0 ? (
              <li className="danger-text">有 {info.unpushed} 個提交只在這台電腦上，刪掉就沒了。</li>
            ) : (
              <li>沒有只在本機的提交。</li>
            )}
            <li>{info.hasRemote ? '遠端有這條分支：只刪本機的，之後還能從遠端拿回來。' : '遠端沒有這條分支。'}</li>
            {info.dirty.length > 0 ? (
              <li className="warn">
                資料夾還有 {info.dirty.length} 個沒提交的修改（{info.dirty.slice(0, 3).join('、')}{info.dirty.length > 3 ? ' 等' : ''}），為了不丟掉它們，<strong>分支不會刪</strong>，只會移除。
              </li>
            ) : (
              <li>資料夾會先切回 {info.baseBranch}（environment.ts 會還原），再刪分支。</li>
            )}
            <li>只刪本機，不會動遠端。</li>
          </ul>
        )}

        {error && <div className="error small">{error}</div>}
        <div className="row modal-actions">
          <button disabled={busy} onClick={onClose}>取消</button>
          <button className="danger-solid" disabled={busy || info === undefined} onClick={confirm}>
            {busy ? '處理中…' : deleteBranch ? '移除並刪除分支' : '移除'}
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
          <Markdown text={entry.text} />
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
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

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

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
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

  function finish() {
    const ok = window.confirm(`完成 ${item.ticketKey}，讓出 ${item.folder} 給下一張？\n\n資料夾要乾淨（改動都提交或捨棄了）；environment.ts（瀏覽器測試切 SIT／UAT 用的）會順便還原。`);
    if (ok) act(() => api.finish(item.id, true));
  }
  const active = !['committed', 'removed'].includes(item.status);
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
          {canRetest && (
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
          {item.status === 'review' && item.folder && (
            <button className="primary" disabled={busy} onClick={finish}>
              完成這張單
            </button>
          )}
          {['blocked', 'failed', 'stopped'].includes(item.status) && <button disabled={busy} onClick={() => act(() => api.retry(item.id))}>重試</button>}
          {active && item.threadId && (
            <button
              disabled={busy || running}
              title={running ? 'AI 執行中，等它停下來再更新需求' : '重新讀 Jira，跟上次的內容比對，請 AI 在對話裡說明有沒有變更、打算怎麼改'}
              onClick={() => act(async () => {
                stick.current = true;
                await api.requestRequirementUpdate(item.id);
              })}
            >
              {busy ? '處理中…' : '更新需求'}
            </button>
          )}
          {active && (
            <details className="more">
              <summary>更多</summary>
              <div className="more-menu">
                {item.threadId && item.folder && <button onClick={() => act(() => api.openInVSCode(item.id))}>在 VS Code 查看</button>}
                {item.status !== 'review' && !running && item.status !== 'preparing' && item.folder && <button onClick={finish}>完成這張單</button>}
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
          {item.threadId && <Stages item={item} />}
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
            rows={3}
            value={text}
            placeholder={
              running ? '補充指示（會插進正在進行的這一輪）。可以直接貼上截圖。'
              : awaitingYou ? 'AI 在等你回答…（⌘＋Enter 送出，可以直接貼上截圖）'
              : '跟 AI 說…（⌘＋Enter 送出，可以直接貼上截圖）'
            }
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.metaKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="row composer-actions">
            {running && <button disabled={busy} onClick={() => act(() => api.interrupt(item.id))}>中斷</button>}
            <button className="primary" disabled={busy || (!text.trim() && images.length === 0)} onClick={send}>
              送出
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
