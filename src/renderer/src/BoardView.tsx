// 執行看板：四個資料夾目前在做什麼，以及每張單的進度、AI 的提問與你的回覆。
import { useEffect, useRef, useState } from 'react';
import type { BoardState, ChangedFile, WorkItem, WorkStatus } from '../../shared/types';
import { Markdown } from './Markdown';
import { TerminalPanel } from './TerminalPanel';

const api = window.flowpilot;

/** 已經結束的狀態 */
const FINISHED: WorkStatus[] = ['failed', 'stopped', 'removed', 'committed'];

const STATUS_LABEL: Record<WorkStatus, string> = {
  queued: '排隊中',
  preparing: '準備中',
  running: '執行中',
  waiting: '等你回答',
  review: '等你審查',
  blocked: '卡住了',
  failed: '失敗',
  stopped: '已停止',
  removed: '已移除',
  committed: '已提交',
};

function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

/** 回覆區塊：內容變長時，如果你停在最下面就自動跟著捲；你往上捲去看前面時不會被拉回來 */
function MessageBox({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const box = ref.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [text]);
  return (
    <div
      ref={ref}
      className={`message-box ${live ? 'live' : ''}`}
      onScroll={(e) => {
        const box = e.currentTarget;
        stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }}
    >
      <Markdown text={text} />
      {live && <span className="cursor" />}
    </div>
  );
}

/** 審查與提交：勾選要提交的檔案（environment.ts 預設不勾），提交後讓出資料夾 */
function ReviewPanel({ item }: { item: WorkItem }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const list = await api.changedFiles(item.id);
      setFiles(list);
      setChosen(new Set(list.filter((f) => f.suggested).map((f) => f.path)));
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    load();
  }, [item.id]);

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      await api.commit(item.id, [...chosen]);
    } catch (e) {
      setError(errorText(e));
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-panel">
      <div className="review-head">
        <strong>審查與提交</strong>
        <span className="muted small">提交訊息：<code>{item.prTitle}</code>（不會推送）</span>
        <button className="link" onClick={load}>重新整理</button>
      </div>
      {files === null && !error && <p className="muted small">讀取改動中…</p>}
      {files?.length === 0 && <p className="muted small">沒有任何改動。</p>}
      {files && files.length > 0 && (
        <ul className="files">
          {files.map((f) => (
            <li key={f.path}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has(f.path)}
                  onChange={() =>
                    setChosen((prev) => {
                      const next = new Set(prev);
                      next.has(f.path) ? next.delete(f.path) : next.add(f.path);
                      return next;
                    })
                  }
                />
                <span className="code">{f.code}</span> <code>{f.path}</code>
                {!f.suggested && <span className="muted small">（瀏覽器測試切 SIT／UAT 用的，預設不提交，提交後會還原）</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="primary" disabled={busy || !files?.length || chosen.size === 0} onClick={commit}>
          {busy ? '提交中…' : `提交 ${chosen.size} 個檔案`}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ItemCard({ item, focused, streaming }: { item: WorkItem; focused: boolean; streaming: string | undefined }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(item.status === 'waiting' || item.status === 'review');
  const [terminal, setTerminal] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);
  useEffect(() => {
    if (item.status === 'waiting' || item.status === 'review') setExpanded(true);
  }, [item.status]);

  async function act(action: () => Promise<void>) {
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

  const canReply = !!item.threadId && !['queued', 'preparing'].includes(item.status) && item.pending?.kind !== 'approval' && item.pending?.kind !== 'decision';

  return (
    <section ref={ref} className={`item status-${item.status} ${focused ? 'focused' : ''}`}>
      <div className="item-head">
        <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
        <strong>{item.ticketKey}</strong>
        <span className="item-title">{item.ticketSummary}</span>
      </div>
      <div className="item-meta muted">
        {item.folder ?? '等資料夾空出來'} · <code>{item.branch}</code> · {item.skill}
        {item.targetMerchants.length > 0 && ` · 之後移植到 ${item.targetMerchants.map((m) => `m${m}`).join('、')}`}
      </div>
      {item.activity && <div className="activity">{item.activity}</div>}

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
        </div>
      )}

      {streaming !== undefined ? (
        <div className="message">
          <div className="live-label">AI 正在回覆…</div>
          <MessageBox text={streaming} live />
        </div>
      ) : (
        item.lastMessage && (
          <div className="message">
            <button className="link" onClick={() => setExpanded(!expanded)}>{expanded ? '收起 AI 的最後回覆' : '看 AI 的最後回覆'}</button>
            {expanded && <MessageBox text={item.lastMessage} live={false} />}
          </div>
        )
      )}

      {canReply && (
        <div className="reply">
          <textarea
            rows={2}
            value={text}
            placeholder={item.status === 'running' ? '補充指示（會插進正在進行的這一輪）' : '回覆 AI（⌘＋Enter 送出）'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.metaKey && text.trim()) act(() => api.reply(item.id, text.trim()).then(() => setText('')));
            }}
          />
          <button className="primary" disabled={busy || !text.trim()} onClick={() => act(() => api.reply(item.id, text.trim()).then(() => setText('')))}>
            送出
          </button>
        </div>
      )}

      <div className="row">
        {item.lane === 'conversation' && (
          <button className="primary" disabled={busy} onClick={() => act(() => api.handOff(item.id))}>
            問完了，換下一張
          </button>
        )}
        {item.folder && !['running', 'preparing', 'committed', 'removed'].includes(item.status) && (
          <button className={reviewing ? 'on' : ''} onClick={() => setReviewing(!reviewing)}>
            {reviewing ? '收起審查' : '審查與提交'}
          </button>
        )}
        {item.threadId && item.folder && (
          <button className={terminal ? 'on' : ''} onClick={() => setTerminal(!terminal)}>
            {terminal ? '收起終端機' : '在這裡打開終端機'}
          </button>
        )}
        {item.threadId && item.folder && <button onClick={() => act(() => api.openInVSCode(item.id))}>在 VS Code 查看</button>}
        {['running', 'waiting', 'preparing'].includes(item.status) && item.pending?.kind !== 'decision' && <button disabled={busy} onClick={() => act(() => api.stop(item.id))}>停止</button>}
        {['blocked', 'failed', 'stopped'].includes(item.status) && <button disabled={busy} onClick={() => act(() => api.retry(item.id))}>重試</button>}
        {!['committed', 'removed'].includes(item.status) && (
          <button
            className="link danger"
            disabled={busy}
            onClick={() => {
              const running = ['running', 'preparing'].includes(item.status);
              const message =
                `從看板移除 ${item.ticketKey}？` +
                (running ? '\nAI 正在執行，會先中斷它。' : '') +
                (item.folder ? `\n不會動到 ${item.folder} 裡的檔案或分支；AI 已經改的內容會留在資料夾裡，要自己處理。` : '\n還沒開始，不會動到任何檔案或分支。');
              if (window.confirm(message)) act(() => api.remove(item.id));
            }}
          >
            移除
          </button>
        )}
      </div>
      {reviewing && <ReviewPanel item={item} />}
      {terminal && item.threadId && <TerminalPanel itemId={item.id} onClose={() => setTerminal(false)} />}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

export function BoardView() {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [streams, setStreams] = useState<Record<number, string>>({});
  const [focus, setFocus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .board()
      .then((b) => {
        setBoard(b);
        setStreams(b.streaming);
      })
      .catch((e) => setError(errorText(e)));
    const offBoard = api.onBoardChanged((b) => {
      setBoard(b);
      // 寫完的回覆已經存進最後回覆，從即時內容拿掉
      setStreams((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id in b.streaming)));
    });
    const offStream = api.onStream((itemId, text) => setStreams((prev) => ({ ...prev, [itemId]: text })));
    const offFocus = api.onFocusItem(setFocus);
    return () => {
      offBoard();
      offStream();
      offFocus();
    };
  }, []);

  if (!board) return <main>{error ? <div className="error">{error}</div> : <p className="muted">讀取中…</p>}</main>;

  const byId = new Map(board.items.map((i) => [i.id, i]));
  const talking = board.items.find((i) => i.lane === 'conversation' && !FINISHED.includes(i.status));
  const waitingTurn = board.items.filter((i) => i.lane === 'waiting' && !FINISHED.includes(i.status));
  const order: WorkStatus[] = ['waiting', 'review', 'blocked', 'failed', 'running', 'preparing', 'queued', 'stopped'];
  const developing = board.items
    .filter((i) => i.lane === 'development' && !FINISHED.includes(i.status))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  const finished = board.items.filter((i) => FINISHED.includes(i.status) || i.lane === 'done').sort((a, b) => b.id - a.id);
  const count = (status: WorkStatus) => developing.filter((i) => i.status === status).length;
  const full = board.development.count >= board.development.max;

  return (
    <main>
      <header>
        <div>
          <h1>執行看板</h1>
          <p className="muted">一次只跟一張單對話；問完按「換下一張」，它就移到開發佇列在背景跑，你再自己點進去看。</p>
        </div>
      </header>

      {board.pendingRun && (
        <div className="pending-run">
          有一份已確認、還沒開始的計畫（{board.pendingRun.ticketKeys.join('、')}）。
          <button className="primary" onClick={() => api.startRun(board.pendingRun!.id).catch((e) => setError(errorText(e)))}>開始執行</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="board-scroll">
        <div className="folders">
          {board.folders.map((f) => {
            const item = f.itemId ? byId.get(f.itemId) : null;
            return (
              <div key={f.name} className={`folder ${item ? `status-${item.status}` : 'idle'}`} onClick={() => item && setFocus(item.id)}>
                <div className="folder-name">{f.name}</div>
                {item ? (
                  <>
                    <div>
                      <strong>{item.ticketKey}</strong> <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
                    </div>
                    <div className="muted small">{item.lane === 'conversation' ? '對話中' : '開發佇列'}</div>
                  </>
                ) : (
                  <div className="muted">空閒</div>
                )}
              </div>
            );
          })}
        </div>

        <h2 className="section">對話中</h2>
        {talking ? (
          <>
            <ItemCard item={talking} focused={focus === talking.id} streaming={streams[talking.id]} />
            {full && <p className="warn">開發佇列已滿（{board.development.count}／{board.development.max}），要先審查提交或移除一張，才能換下一張。</p>}
          </>
        ) : (
          <p className="muted">{board.nextBlockedReason ?? (waitingTurn.length ? '準備下一張中…' : '目前沒有要對話的單。到「單列表」勾選單、確認計畫後就會開始。')}</p>
        )}

        {waitingTurn.length > 0 && (
          <>
            <h2 className="section">排隊等對話（{waitingTurn.length}）</h2>
            <ol className="queue">
              {waitingTurn.map((i) => (
                <li key={i.id}>
                  <strong>{i.ticketKey}</strong> <span className="muted">{i.ticketSummary}</span>
                  {i.status !== 'queued' && <span className={`status ${i.status}`}>{STATUS_LABEL[i.status]}</span>}
                  <button
                    className="link danger"
                    onClick={() => {
                      if (window.confirm(`從排隊中移除 ${i.ticketKey}？還沒開始，不會動到任何檔案或分支。`)) {
                        api.remove(i.id).catch((e) => setError(errorText(e)));
                      }
                    }}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}

        <h2 className="section">
          開發佇列（{board.development.count}／{board.development.max}）
          <span className="muted small">
            {count('waiting') > 0 && <span className="status waiting">{count('waiting')} 張等你回答</span>}
            {count('review') > 0 && <span className="status review">{count('review')} 張等你審查</span>}
            {count('running') + count('preparing') > 0 && <span className="status running">{count('running') + count('preparing')} 張執行中</span>}
          </span>
        </h2>
        {developing.length === 0 && <p className="muted">開發佇列是空的。</p>}
        {developing.map((item) => (
          <ItemCard key={item.id} item={item} focused={focus === item.id} streaming={streams[item.id]} />
        ))}

        {finished.length > 0 && (
          <details className="finished">
            <summary>已完成（{finished.length}）</summary>
            {finished.map((item) => (
              <ItemCard key={item.id} item={item} focused={focus === item.id} streaming={streams[item.id]} />
            ))}
          </details>
        )}
      </div>
    </main>
  );
}

