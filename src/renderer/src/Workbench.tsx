// 工作台：左邊是你手上的單，中間跟 AI 對話，右邊是本機網站與 Git 改動。
import { useEffect, useState } from 'react';
import type { BoardState, WorkItem, WorkStatus } from '../../shared/types';
import { ChatPanel, errorText, STATUS_LABEL } from './ChatPanel';
import { FolderTerminalPanel, GitPanel } from './SidePanels';

const api = window.flowpilot;

const FINISHED: WorkStatus[] = ['failed', 'stopped', 'removed', 'committed'];

function Row({ item, selected, onSelect, extra }: { item: WorkItem; selected: boolean; onSelect(): void; extra?: React.ReactNode }) {
  return (
    <li className={`ticket ${selected ? 'selected' : ''} status-${item.status}`} onClick={onSelect}>
      <div className="ticket-line">
        <strong>{item.ticketKey}</strong>
        <span className="muted small">{item.project}{item.merchant ? ` m${item.merchant}` : ''}</span>
        {item.status !== 'queued' && <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>}
        {extra}
      </div>
      <div className="muted small ticket-summary">{item.ticketSummary}</div>
    </li>
  );
}

export function Workbench({ onNewTicket }: { onNewTicket(): void }) {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.board().then(setBoard).catch((e) => setError(errorText(e)));
    const offBoard = api.onBoardChanged(setBoard);
    const offFocus = api.onFocusItem(setSelected);
    return () => {
      offBoard();
      offFocus();
    };
  }, []);

  const items = board?.items ?? [];
  const talking = items.find((i) => i.lane === 'conversation' && !FINISHED.includes(i.status));
  const waitingTurn = items.filter((i) => i.lane === 'waiting' && !FINISHED.includes(i.status));
  const order: WorkStatus[] = ['waiting', 'review', 'blocked', 'running', 'preparing', 'queued'];
  const developing = items.filter((i) => i.lane === 'development' && !FINISHED.includes(i.status)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  const finished = items.filter((i) => FINISHED.includes(i.status)).sort((a, b) => b.id - a.id);

  // 預設選對話中的那張；選的那張不見了就換一張
  useEffect(() => {
    if (!board) return;
    if (selected === null || !items.some((i) => i.id === selected)) setSelected(talking?.id ?? developing[0]?.id ?? null);
  }, [board]);

  const current = items.find((i) => i.id === selected) ?? null;
  const full = !!board && board.development.count >= board.development.max;
  const handOffBlocked = full ? `開發佇列已滿（${board!.development.count}／${board!.development.max}），先完成或移除一張才能換下一張` : null;

  return (
    <div className="workbench">
      <aside className="sidebar">
        <button className="primary new-ticket" onClick={onNewTicket}>＋ 開始新的單</button>
        {board?.pendingRun && (
          <div className="pending-run small">
            有確認好、還沒開始的計畫（{board.pendingRun.ticketKeys.join('、')}）
            <button className="primary" onClick={() => api.startRun(board.pendingRun!.id).catch((e) => setError(errorText(e)))}>開始</button>
          </div>
        )}
        {error && <div className="error small">{error}</div>}

        <div className="side-section">對話中</div>
        <ul className="tickets">
          {talking ? <Row item={talking} selected={selected === talking.id} onSelect={() => setSelected(talking.id)} /> : <li className="muted small empty-row">{board?.nextBlockedReason ?? (waitingTurn.length ? '準備下一張中…' : '沒有')}</li>}
        </ul>

        {waitingTurn.length > 0 && (
          <>
            <div className="side-section">排隊（{waitingTurn.length}）</div>
            <ul className="tickets">
              {waitingTurn.map((i) => (
                <Row
                  key={i.id}
                  item={i}
                  selected={selected === i.id}
                  onSelect={() => setSelected(i.id)}
                  extra={
                    <button
                      className="link danger small"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`從排隊中移除 ${i.ticketKey}？還沒開始，不會動到任何檔案或分支。`)) api.remove(i.id).catch((err) => setError(errorText(err)));
                      }}
                    >
                      移除
                    </button>
                  }
                />
              ))}
            </ul>
          </>
        )}

        <div className="side-section">開發佇列（{board?.development.count ?? 0}／{board?.development.max ?? '-'}）</div>
        <ul className="tickets">
          {developing.length === 0 && <li className="muted small empty-row">沒有</li>}
          {developing.map((i) => (
            <Row key={i.id} item={i} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
          ))}
        </ul>

        {finished.length > 0 && (
          <details className="finished-list">
            <summary className="side-section">已結束（{finished.length}）</summary>
            <ul className="tickets">
              {finished.map((i) => (
                <Row key={i.id} item={i} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
              ))}
            </ul>
          </details>
        )}

      </aside>

      <main className="center">
        {current ? (
          <ChatPanel key={current.id} item={current} canHandOff={!full} handOffBlocked={handOffBlocked} />
        ) : (
          <div className="empty-state">
            <p>還沒有正在處理的單。</p>
            <button className="primary" onClick={onNewTicket}>開始新的單</button>
          </div>
        )}
      </main>

      <aside className="right">
        {current?.folder ? (
          <>
            <FolderTerminalPanel item={current} />
            <GitPanel item={current} />
          </>
        ) : (
          <p className="muted small">這張單分配到資料夾之後，這裡會顯示終端機與 Git 改動。</p>
        )}
      </aside>
    </div>
  );
}
