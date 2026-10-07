// 執行看板：四個資料夾目前在做什麼，以及每張單的進度、AI 的提問與你的回覆。
import { useEffect, useRef, useState } from 'react';
import type { BoardState, WorkItem, WorkStatus } from '../../shared/types';

const api = window.flowpilot;

const STATUS_LABEL: Record<WorkStatus, string> = {
  queued: '排隊中',
  preparing: '準備中',
  running: '執行中',
  waiting: '等你回答',
  review: '等你審查',
  blocked: '卡住了',
  failed: '失敗',
  stopped: '已停止',
};

function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

function ItemCard({ item, focused }: { item: WorkItem; focused: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(item.status === 'waiting' || item.status === 'review');
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

  const canReply = !!item.threadId && !['queued', 'preparing'].includes(item.status) && item.pending?.kind !== 'approval';

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

      {item.lastMessage && (
        <div className="message">
          <button className="link" onClick={() => setExpanded(!expanded)}>{expanded ? '收起 AI 的最後回覆' : '看 AI 的最後回覆'}</button>
          {expanded && <pre>{item.lastMessage}</pre>}
        </div>
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
        {item.threadId && item.folder && <button onClick={() => act(() => api.openInVSCode(item.id))}>在 VS Code 查看</button>}
        {['running', 'waiting', 'preparing'].includes(item.status) && <button disabled={busy} onClick={() => act(() => api.stop(item.id))}>停止</button>}
        {['blocked', 'failed', 'stopped'].includes(item.status) && <button disabled={busy} onClick={() => act(() => api.retry(item.id))}>重試</button>}
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

export function BoardView() {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.board().then(setBoard).catch((e) => setError(errorText(e)));
    const offBoard = api.onBoardChanged(setBoard);
    const offFocus = api.onFocusItem(setFocus);
    return () => {
      offBoard();
      offFocus();
    };
  }, []);

  if (!board) return <main>{error ? <div className="error">{error}</div> : <p className="muted">讀取中…</p>}</main>;

  const byId = new Map(board.items.map((i) => [i.id, i]));
  const order: WorkStatus[] = ['waiting', 'blocked', 'review', 'running', 'preparing', 'queued', 'failed', 'stopped'];
  const items = [...board.items].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);

  return (
    <main>
      <header>
        <div>
          <h1>執行看板</h1>
          <p className="muted">每個資料夾一次做一張單。AI 問你問題或做完時會跳通知；也可以在 VS Code 的終端機分頁直接看它工作。</p>
        </div>
      </header>

      {board.pendingRun && (
        <div className="pending-run">
          有一份已確認、還沒開始的計畫（{board.pendingRun.ticketKeys.join('、')}）。
          <button className="primary" onClick={() => api.startRun(board.pendingRun!.id).catch((e) => setError(errorText(e)))}>開始執行</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}

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
                  <div className="muted small">{item.activity}</div>
                </>
              ) : (
                <div className="muted">空閒</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="items">
        {items.length === 0 && <p className="empty">還沒有工作。到「單列表」勾選單、確認計畫後就會開始。</p>}
        {items.map((item) => (
          <ItemCard key={item.id} item={item} focused={focus === item.id} />
        ))}
      </div>
    </main>
  );
}
