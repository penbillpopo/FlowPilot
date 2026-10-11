// 工作台：左邊是你手上的單，中間跟 AI 對話，右邊是測試環境與帳號、本機網站與 Git 改動。
import { createContext, useContext, useEffect, useState } from 'react';
import type { BoardState, WorkItem, WorkStatus } from '../../shared/types';
import { ChatPanel, errorText, STATUS_LABEL } from './ChatPanel';
import { FolderTerminalPanel, GitPanel, TestPanel } from './SidePanels';

const api = window.flowpilot;

const FINISHED: WorkStatus[] = ['failed', 'stopped', 'removed', 'committed'];

/** 專案的前台／後台（來自設定檔），用來標示這一列做在哪裡 */
const SideContext = createContext<Record<string, string>>({});

function ProjectTag({ item }: { item: WorkItem }) {
  const side = useContext(SideContext)[item.project] ?? '';
  const short = side.split('（')[0];
  return (
    <span className={`side ${short.startsWith('前台') ? 'front' : 'back'}`}>
      {short && `${short} · `}{item.project}{item.merchant ? ` m${item.merchant}` : ''}
    </span>
  );
}

function Row({ item, selected, onSelect, extra }: { item: WorkItem; selected: boolean; onSelect(): void; extra?: React.ReactNode }) {
  return (
    <li className={`ticket ${selected ? 'selected' : ''} status-${item.status}`} onClick={onSelect}>
      <div className="ticket-line">
        <strong>{item.ticketKey}</strong>
        {item.status !== 'queued' && <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>}
        {extra}
      </div>
      <div className="ticket-tag"><ProjectTag item={item} /></div>
      <div className="muted small ticket-summary">{item.ticketSummary}</div>
      {item.status === 'queued' && item.activity && <div className="muted small">{item.activity}</div>}
    </li>
  );
}

/** 右邊：測試固定在上面；Git 改動和終端機用分頁切換（兩個都一直開著，切換不會中斷終端機） */
function RightPanels({ item }: { item: WorkItem }) {
  const [tab, setTab] = useState<'git' | 'term'>('git');
  const [changes, setChanges] = useState(0);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  return (
    <>
      <TestPanel item={item} />
      <div className="right-tabs" role="tablist">
        <button role="tab" className={tab === 'git' ? 'on' : ''} onClick={() => setTab('git')}>
          Git 改動{changes > 0 && <span className="tab-count">{changes}</span>}
        </button>
        <button role="tab" className={tab === 'term' ? 'on' : ''} onClick={() => setTab('term')} title={siteUrl ? `本機網站在跑：${siteUrl}` : undefined}>
          終端機{siteUrl && <span className="tab-dot" />}
        </button>
      </div>
      <div className="tab-body" hidden={tab !== 'git'}>
        <GitPanel item={item} onCount={setChanges} />
      </div>
      <div className="tab-body" hidden={tab !== 'term'}>
        <FolderTerminalPanel item={item} onSiteUrl={setSiteUrl} />
      </div>
    </>
  );
}

export function Workbench({ onGoTickets }: { onGoTickets(): void }) {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sides, setSides] = useState<Record<string, string>>({});

  useEffect(() => {
    api.board().then(setBoard).catch((e) => setError(errorText(e)));
    api.planOptions().then((o) => setSides(Object.fromEntries(o.projects.map((p) => [p.name, p.side])))).catch(() => {});
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
    <SideContext.Provider value={sides}>
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
            <p>還沒有正在處理的單。到「單列表」勾選單、確認計畫後就會出現在這裡。</p>
            <button className="primary" onClick={onGoTickets}>到單列表</button>
          </div>
        )}
      </main>

      <aside className="right">
        {current && FINISHED.includes(current.status) ? (
          // 已結束的單：資料夾可能已經是別張單在用，這裡不再提供會動到資料夾的操作
          <div className="panel finished-note">
            <strong>這張單已結束</strong>
            <p className="muted small">
              {current.status === 'committed' ? '已完成，' : ''}資料夾 {current.folder ?? '—'} 已經讓出，可能正在做別張單，所以這裡不再顯示環境切換、終端機和 Git 操作。
            </p>
            <p className="small">分支：<code>{current.branch}</code></p>
            {current.activity && <p className="muted small">{current.activity}</p>}
          </div>
        ) : current?.folder ? (
          <RightPanels key={current.id} item={current} />
        ) : current ? (
          <p className="muted small">這張單分配到資料夾之後，這裡會顯示終端機與 Git 改動。</p>
        ) : null}
      </aside>
    </div>
    </SideContext.Provider>
  );
}
