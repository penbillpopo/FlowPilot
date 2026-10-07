// 主畫面：上方切換「單列表」與「執行看板」。
// 單列表：列出 Jira 上進行中的單，由你勾選這次要做哪幾張；確認後進入計畫表，計畫確認後跳到執行看板。
import { useEffect, useState } from 'react';
import type { JiraTicket, RunSummary } from '../../shared/types';
import { BoardView } from './BoardView';
import { PlanView } from './PlanView';

const api = window.flowpilot;

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function App() {
  const [tab, setTab] = useState<'tickets' | 'board'>('tickets');

  // 點系統通知時跳到執行看板
  useEffect(() => api.onFocusItem(() => setTab('board')), []);

  return (
    <div className="shell">
      <nav>
        <button className={tab === 'tickets' ? 'on' : ''} onClick={() => setTab('tickets')}>單列表</button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>執行看板</button>
      </nav>
      {/* 兩個分頁都保持掛著，切換時不會丟掉計畫表或輸入到一半的回覆 */}
      <div hidden={tab !== 'tickets'}>
        <TicketList onConfirmed={() => setTab('board')} />
      </div>
      <div hidden={tab !== 'board'}>
        <BoardView />
      </div>
    </div>
  );
}

function TicketList({ onConfirmed }: { onConfirmed(): void }) {
  const [tickets, setTickets] = useState<JiraTicket[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState<{ run: RunSummary; tickets: JiraTicket[] } | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listTickets();
      setTickets(list);
      // 重新整理後，已經不在清單上的單取消勾選
      setSelected((prev) => new Set([...prev].filter((key) => list.some((t) => t.key === key))));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function confirm() {
    if (!tickets) return;
    const chosen = tickets.filter((t) => selected.has(t.key));
    setPlanning({ run: await api.createRun(chosen), tickets: chosen });
  }

  if (planning) {
    return (
      <PlanView
        run={planning.run}
        tickets={planning.tickets}
        onBack={() => setPlanning(null)}
        onConfirmed={() => {
          setPlanning(null);
          setSelected(new Set());
          onConfirmed();
        }}
      />
    );
  }

  const allChecked = !!tickets?.length && tickets.every((t) => selected.has(t.key));

  return (
    <main>
      <header>
        <div>
          <h1>今日開發任務</h1>
          <p className="muted">Jira 上指派給你、狀態為「進行中」的單。勾選這次要做的單。</p>
        </div>
        <div className="actions">
          <button onClick={() => api.openSettingsFile()}>設定檔</button>
          <button onClick={refresh} disabled={loading}>{loading ? '讀取中…' : '重新整理'}</button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {tickets && tickets.length === 0 && !error && <p className="empty">目前沒有進行中的單。</p>}

      {tickets && tickets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th className="check">
                <input
                  type="checkbox"
                  aria-label="全選"
                  checked={allChecked}
                  onChange={() => setSelected(allChecked ? new Set() : new Set(tickets.map((t) => t.key)))}
                />
              </th>
              <th>單號</th>
              <th>標題</th>
              <th>主單</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.key} className={selected.has(t.key) ? 'selected' : ''} onClick={() => toggle(t.key)}>
                <td className="check">
                  <input type="checkbox" checked={selected.has(t.key)} onChange={() => toggle(t.key)} onClick={(e) => e.stopPropagation()} />
                </td>
                <td className="key">
                  <a href={t.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.openExternal(t.url); }}>{t.key}</a>
                  <span className="tag">{t.issueType}</span>
                </td>
                <td>{t.summary}</td>
                <td className="parent">
                  {t.parent ? (
                    <>
                      <a href={t.parent.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.openExternal(t.parent!.url); }}>{t.parent.key}</a>
                      <span className="muted">{t.parent.summary}</span>
                    </>
                  ) : (
                    <span className="muted">（本身是主單）</span>
                  )}
                </td>
                <td className="time">{formatTime(t.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer>
        <span className="muted">確認後，AI 會讀每張單判斷專案與商戶，產生計畫表給你確認。</span>
        <button className="primary" disabled={selected.size === 0} onClick={confirm}>
          確認這 {selected.size} 張，產生計畫
        </button>
      </footer>
    </main>
  );
}
