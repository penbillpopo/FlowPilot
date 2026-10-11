// 工作台：左邊是你手上的單，中間跟 AI 對話，右邊是測試環境與帳號、本機網站與 Git 改動。
import { useEffect, useState } from 'react';
import type { BoardState, WorkItem, WorkStatus } from '../../shared/types';
import { ChatPanel, errorText, STATUS_LABEL } from './ChatPanel';
import { FolderTerminalPanel, GitPanel, TestPanel } from './SidePanels';

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
      {item.status === 'queued' && item.activity && <div className="muted small">{item.activity}</div>}
    </li>
  );
}

export function Workbench() {
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
  // 進行中：已經分到資料夾的（等你回答的排最上面）；排隊：等專案有空的資料夾
  const order: WorkStatus[] = ['waiting', 'blocked', 'failed', 'review', 'running', 'preparing'];
  const active = items.filter((i) => i.status !== 'queued' && !FINISHED.includes(i.status)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  const waitingTurn = items.filter((i) => i.status === 'queued');
  const finished = items.filter((i) => FINISHED.includes(i.status)).sort((a, b) => b.id - a.id);

  // 預設選對話中的那張；選的那張不見了就換一張
  useEffect(() => {
    if (!board) return;
    if (selected === null || !items.some((i) => i.id === selected)) setSelected(active[0]?.id ?? waitingTurn[0]?.id ?? null);
  }, [board]);

  const current = items.find((i) => i.id === selected) ?? null;

  return (
    <div className="workbench">
      <aside className="sidebar">
        {board?.pendingRun && (
          <div className="pending-run small">
            有確認好、還沒開始的計畫（{board.pendingRun.ticketKeys.join('、')}）
            <button className="primary" onClick={() => api.startRun(board.pendingRun!.id).catch((e) => setError(errorText(e)))}>開始</button>
          </div>
        )}
        {error && <div className="error small">{error}</div>}

        <div className="side-section">進行中（{active.length}）</div>
        <ul className="tickets">
          {active.length === 0 && <li className="muted small empty-row">沒有</li>}
          {active.map((i) => (
            <Row key={i.id} item={i} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
          ))}
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
          <ChatPanel key={current.id} item={current} />
        ) : (
          <div className="empty-state">
            <p>還沒有正在處理的單。到上方的「單列表」勾選單、確認計畫後就會出現在這裡。</p>
          </div>
        )}
      </main>

      <aside className="right">
        {current?.folder ? (
          <>
            <TestPanel item={current} />
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
