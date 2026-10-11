// 主畫面：上方切換「工作台」與「單列表」。
// 單列表：列出 Jira 上進行中的單，由你勾選這次要做哪幾張；確認後進入計畫表，計畫確認後跳到執行看板。
import { useEffect, useState } from 'react';
import type { JiraTicket, RunSummary } from '../../shared/types';
import { Workbench } from './Workbench';
import { PlanView } from './PlanView';

const api = window.flowpilot;

const STATUS_STORAGE_KEY = 'flowpilot.statuses';

/** 你上次選的狀態（存在這台電腦的瀏覽器儲存空間；讀不到就用設定檔的預設） */
function rememberedStatuses(available: string[], fallback: string[]): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STATUS_STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved)) {
      const valid = saved.filter((s) => available.includes(s));
      if (valid.length) return valid;
    }
  } catch {}
  return fallback.filter((s) => available.includes(s));
}

function rememberStatuses(statuses: string[]) {
  try {
    localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(statuses));
  } catch {}
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function App() {
  const [tab, setTab] = useState<'tickets' | 'board'>('board');

  // 點系統通知時跳到工作台
  useEffect(() => api.onFocusItem(() => setTab('board')), []);

  return (
    <div className="shell">
      <nav>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>工作台</button>
        <button className={tab === 'tickets' ? 'on' : ''} onClick={() => setTab('tickets')}>單列表</button>
      </nav>
      {/* 兩個分頁都保持掛著，切換時不會丟掉計畫表或輸入到一半的回覆 */}
      <div hidden={tab !== 'tickets'}>
        <TicketList onConfirmed={() => setTab('board')} />
      </div>
      <div hidden={tab !== 'board'}>
        <Workbench onGoTickets={() => setTab('tickets')} />
      </div>
    </div>
  );
}

function TicketList({ onConfirmed }: { onConfirmed(): void }) {
  const [tickets, setTickets] = useState<JiraTicket[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marks, setMarks] = useState<Record<string, { reviewed: boolean; active: boolean; branch: boolean }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState<{ run: RunSummary; tickets: JiraTicket[] } | null>(null);
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[] | null>(null);

  async function refresh(chosen = statuses) {
    if (!chosen) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listTickets(chosen);
      setTickets(list);
      // 標記：審閱過了沒、在工作台上、分支已經存在（讀不到就不顯示，不影響列表）
      api.ticketMarks(list.map((t) => t.key)).then(setMarks).catch(() => setMarks({}));
      // 重新整理後，已經不在清單上的單取消勾選
      setSelected((prev) => new Set([...prev].filter((key) => list.some((t) => t.key === key))));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.statusOptions().then(({ statuses: available, defaultStatuses }) => {
      setStatusOptions(available);
      const initial = rememberedStatuses(available, defaultStatuses);
      setStatuses(initial);
      refresh(initial);
    });
  }, []);

  function toggleStatus(status: string) {
    if (!statuses) return;
    const next = statuses.includes(status) ? statuses.filter((s) => s !== status) : statusOptions.filter((s) => s === status || statuses.includes(s));
    setStatuses(next);
    rememberStatuses(next);
    if (next.length) refresh(next);
    else setTickets([]);
  }

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
          <p className="muted">Jira 上指派給你的單。選擇要列出的狀態，再勾選這次要做的單。</p>
        </div>
        <div className="actions">
          <button onClick={() => api.openSettingsFile()}>設定檔</button>
          <button onClick={() => refresh()} disabled={loading}>{loading ? '讀取中…' : '重新整理'}</button>
        </div>
      </header>

      <div className="status-filter">
        <span className="muted">狀態</span>
        {statusOptions.map((status) => (
          <label key={status} className={`chip ${statuses?.includes(status) ? 'on' : ''}`}>
            <input type="checkbox" checked={!!statuses?.includes(status)} onChange={() => toggleStatus(status)} />
            {status}
          </label>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {tickets && tickets.length === 0 && !error && <p className="empty">{statuses?.length ? '選的狀態裡目前沒有單。' : '請至少選一個狀態。'}</p>}

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
              <th className="state">狀態</th>
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
                  <span className="marks">
                    {marks[t.key]?.active && <span className="mark active" title="這張單正在工作台上">工作台上</span>}
                    {marks[t.key]?.branch && <span className="mark" title="本機已經有這張單的分支，確認後會切換過去繼續開發">有分支</span>}
                    {marks[t.key]?.reviewed && <span className="mark" title="已經審閱過，確認後直接沿用上次的結果">已審閱</span>}
                  </span>
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
                <td className="state"><span className="status">{t.status}</span></td>
                <td className="time">{formatTime(t.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer>
        <span className="muted">確認後，AI 會審閱每張單：整理要做什麼、找出單子的問題、判斷專案與商戶，產生計畫表給你確認。</span>
        <button className="primary" disabled={selected.size === 0} onClick={confirm}>
          確認這 {selected.size} 張，產生計畫
        </button>
      </footer>
    </main>
  );
}
