// 主畫面：上方切換「工作台」與「單列表」。
// 單列表：列出 Jira 上進行中的單，由你勾選這次要做哪幾張；確認後進入計畫表，計畫確認後跳到執行看板。
import { useEffect, useRef, useState } from 'react';
import type { JiraTicket, PlanDraft, TicketMark, WorkItem } from '../../shared/types';
import { getLang, jiraName, t, zhOnly } from '../../shared/i18n';
import { play, term, useBoardCues, useSkin, type SkinSettings } from './skin';
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
  return new Date(iso).toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 單列表上不能勾的單：工作台上進行中、已經在計畫表裡；已完成的可以再次開發 */
function locked(mark: TicketMark | undefined) {
  return !!mark && ((mark.active && !mark.done) || mark.planning);
}

export function App() {
  const [tab, setTabNow] = useState<'tickets' | 'board'>('board');
  const [settings, setSkin] = useSkin();
  // 盟軍外觀的換場：防爆門合上 → 換畫面 → 打開
  const [doors, setDoors] = useState<'closing' | 'opening' | null>(null);
  const doorTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nav = useRef<HTMLElement>(null);
  const setTab = (next: 'tickets' | 'board') => {
    if (next === tab && !doors) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (calm) return setTabNow(next);
    doorTimers.current.forEach(clearTimeout);
    setDoors('closing');
    play('doors');
    doorTimers.current = [
      setTimeout(() => {
        setTabNow(next);
        setDoors('opening');
      }, 420),
      setTimeout(() => setDoors(null), 420 + 740),
    ];
  };
  const [items, setItems] = useState<WorkItem[] | null>(null);

  // 點系統通知時跳到工作台
  useEffect(() => api.onFocusItem(() => setTabNow('board')), []);

  // 上方的計數器、雷達與音效看整個工作台
  useEffect(() => {
    api.board().then((b) => setItems(b.items)).catch(() => {});
    return api.onBoardChanged((b) => setItems(b.items));
  }, []);
  useBoardCues(items);

  // 盟軍外觀：按按鈕有一點點聲音
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button:not(:disabled), summary')) play('click');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const list = items ?? [];
  const needYou = list.filter((i) => i.status === 'waiting' || i.status === 'review' || i.status === 'blocked').length;
  const working = list.filter((i) => i.status === 'running' || i.status === 'preparing').length;

  return (
    <div className="shell">
      <nav ref={nav}>
        <div className="emblem" aria-hidden>
          <Emblem faction={settings.theme} size={28} />
          <span className="emblem-name">FLOWPILOT</span>
        </div>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>{term(zhOnly('工作台'))}</button>
        <button className={tab === 'tickets' ? 'on' : ''} onClick={() => setTab('tickets')}>{term(zhOnly('單列表'))}</button>
        <div className="nav-right">
          {(
            <>
              <div className={`radar ${working ? 'live' : ''}`} title={working ? t('AI 正在做 {n} 張單', { n: working }) : t('目前沒有 AI 在做')}>
                <span className="sweep" />
                {list.filter((i) => i.status !== 'removed').slice(0, 8).map((i, n) => (
                  <span key={i.id} className={`blip s-${i.status}`} style={{ '--a': `${n * 47 + 20}deg`, '--r': `${30 + ((n * 23) % 55)}%` } as React.CSSProperties} />
                ))}
              </div>
              <div className="counter" title={t('等你處理的單（等你回答、等你測試、卡住）')}>
                <span className="counter-label">{needYou ? 'ORDERS' : 'STANDBY'}</span>
                <span className="counter-digits">{String(needYou).padStart(5, '0')}</span>
              </div>
            </>
          )}
          <SkinMenu settings={settings} onChange={setSkin} />
        </div>
      </nav>
      {doors && (
        <div className={`blast-doors ${doors}`} style={{ top: nav.current?.offsetHeight ?? 52 }} aria-hidden>
          <div className="door left" />
          <div className="door right" />
          <div className="door-seam" />
          <div className="door-emblem">
            <Emblem faction={settings.theme} size={64} plain />
          </div>
        </div>
      )}
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

/** 陣營徽章（自己畫的）：盟軍是盾牌與三道翼紋，蘇聯是紅星加齒輪外圈 */
function Emblem({ faction, size, plain }: { faction: SkinSettings['theme']; size: number; plain?: boolean }) {
  const id = `em-${faction}-${size}`;
  const [top, bottom] = faction === 'soviet' ? ['#ffd2bc', '#d9361a'] : ['#bfe9ff', '#2a7fd4'];
  const paint = plain ? 'currentColor' : `url(#${id})`;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
      </defs>
      {faction === 'soviet' ? (
        <>
          <circle cx="20" cy="20" r="16.5" fill="none" stroke={paint} strokeWidth="2" strokeDasharray="3.2 2" />
          <circle cx="20" cy="20" r="13" fill="none" stroke={paint} strokeWidth="1.2" />
          <path d="M20 8.5 L22.9 16.6 L31.5 16.9 L24.7 22.2 L27.1 30.5 L20 25.6 L12.9 30.5 L15.3 22.2 L8.5 16.9 L17.1 16.6 Z" fill={paint} />
        </>
      ) : (
        <>
          <path d="M20 3 L35 9 L33 25 Q28 33 20 37 Q12 33 7 25 L5 9 Z" fill="none" stroke={paint} strokeWidth="2" />
          <path d="M10 15 L20 11 L30 15 L26 17 L20 15 L14 17 Z M13 21 L20 18 L27 21 L24 23 L20 21 L16 23 Z M16 27 L20 25 L24 27 L20 31 Z" fill={paint} />
        </>
      )}
    </svg>
  );
}

/** 外觀設定：標準／盟軍；盟軍外觀可以再開關音效、語音、指揮官用語 */
function SkinMenu({ settings, onChange }: { settings: SkinSettings; onChange(patch: Partial<SkinSettings>): void }) {
  const toggles: [keyof SkinSettings, string, string][] = [
    ['sound', t('音效'), t('做完、要你處理、失敗時的提示音')],
    ['voice', t('指揮官語音'), t('用英文念狀態（Construction complete…）')],
    ['lingo', t('指揮官用語'), t('狀態、階段換成作戰用語')],
  ];
  // 點選單外面就收起來
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current?.open && !box.current.contains(e.target as Node)) box.current.removeAttribute('open');
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <details className="skin-menu" ref={box}>
      <summary title={t('外觀設定')} aria-label={t('外觀設定')}>
        <svg className="gear" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path
            fill="currentColor"
            d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.3 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.3-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
            transform="translate(-1 0)"
          />
        </svg>
      </summary>
      <div className="skin-panel">
        <div className="skin-title">{t('外觀')}</div>
        <div className="skin-themes">
          <button className={settings.theme === 'allied' ? 'on' : ''} onClick={() => onChange({ theme: 'allied' })}>
            <span className="skin-swatch allied" />
            {t('盟軍')}
          </button>
          <button className={settings.theme === 'soviet' ? 'on' : ''} onClick={() => onChange({ theme: 'soviet' })}>
            <span className="skin-swatch soviet" />
            {t('蘇聯')}
          </button>
        </div>
        {(
          <ul className="skin-toggles">
            {toggles.map(([key, label, hint]) => (
              <li key={key}>
                <button className={`skin-toggle ${settings[key] ? 'on' : ''}`} onClick={() => onChange({ [key]: !settings[key] })} title={hint}>
                  <span className="led" />
                  {label}
                  <span className="muted small">{settings[key] ? t('開') : t('關')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="skin-toggle on skin-lang"
          title={t('介面語言（語音不會變）')}
          onClick={() => onChange({ lang: settings.lang === 'en' ? 'zh' : 'en' })}
        >
          <span className="led" />
          {t('語言')}
          <span className="muted small">{settings.lang === 'en' ? 'English' : zhOnly('中文')}</span>
        </button>
      </div>
    </details>
  );
}

/**
 * 單列表上的 Jira 狀態：點一下列出這張單能切到的狀態，選了確認後切換。
 * 這是 FlowPilot 對 Jira 唯一的寫入（其他一律只讀）。
 */
function StatusSwitch({ ticket, onChanged, onError }: { ticket: JiraTicket; onChanged(status: string): void; onError(message: string): void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; name: string; to: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const message = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation(); // 不要順便勾選這一列
    if (open) return setOpen(false);
    setOpen(true);
    setOptions(null);
    try {
      setOptions(await api.ticketTransitions(ticket.key));
    } catch (err) {
      setOpen(false);
      onError(message(err));
    }
  }

  async function pick(e: React.MouseEvent, option: { id: string; to: string }) {
    e.stopPropagation();
    if (!window.confirm(t('把 {key} 的 Jira 狀態從「{from}」改成「{to}」？\n\nJira 上的同事都會看到這個變更。', { key: ticket.key, from: jiraName(ticket.status), to: jiraName(option.to) }))) return;
    setBusy(true);
    try {
      onChanged(await api.transitionTicket(ticket.key, option.id));
      setOpen(false);
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const choices = options?.filter((o) => o.to !== ticket.status) ?? [];
  return (
    <div className="status-switch" ref={box}>
      <button className="status" onClick={toggle} disabled={busy} title={t('切換 Jira 狀態')}>
        {busy ? t('切換中…') : jiraName(ticket.status)}
        <span className="caret">▼</span>
      </button>
      {open && (
        <div className="status-menu" onClick={(e) => e.stopPropagation()}>
          {!options && <span className="muted small">{t('讀取中…')}</span>}
          {options && choices.length === 0 && <span className="muted small">{t('沒有可以切換的狀態')}</span>}
          {choices.map((o) => (
            <button key={o.id} onClick={(e) => pick(e, o)}>{jiraName(o.to)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function TicketList({ onConfirmed }: { onConfirmed(): void }) {
  const [tickets, setTickets] = useState<JiraTicket[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marks, setMarks] = useState<Record<string, TicketMark>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 計畫表：加進去的單一直留著（按返回也不會清掉），審閱在背景跑
  const [drafts, setDrafts] = useState<PlanDraft[]>([]);
  const [showPlan, setShowPlan] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[] | null>(null);

  async function refresh(chosen = statuses) {
    if (!chosen) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listTickets(chosen);
      setTickets(list);
      // 標記：在工作台上（不能再選）、分支已經存在（讀不到就不顯示，不影響列表）
      api.ticketMarks(list.map((t) => t.key)).then(setMarks).catch(() => setMarks({}));
      // 重新整理後，已經不在清單上的單取消勾選
      setSelected((prev) => new Set([...prev].filter((key) => list.some((t) => t.key === key))));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setLoading(false);
    }
  }

  const reloadMarks = () => {
    const keys = tickets?.map((t) => t.key) ?? [];
    if (keys.length) api.ticketMarks(keys).then(setMarks).catch(() => {});
  };

  useEffect(() => {
    api.planDrafts().then(setDrafts).catch(() => {});
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

  // 工作台有變動（單進來、結束、移除）時，標記跟著更新；在工作台上的單取消勾選
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return api.onBoardChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const keys = tickets?.map((t) => t.key) ?? [];
        if (!keys.length) return;
        api.ticketMarks(keys).then((next) => {
          setMarks(next);
          setSelected((prev) => new Set([...prev].filter((key) => !locked(next[key]))));
        }).catch(() => {});
      }, 500);
    });
  }, [tickets]);

  function toggle(key: string) {
    if (locked(marks[key])) return; // 在工作台上進行中、已經在計畫表裡的單不能再選；已完成的可以再次開發
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  /** 一次加一個任務：勾一張就是那張；勾好幾張就合成一個任務（同一條分支、同一段對話、一個 PR） */
  async function addToPlan() {
    if (!tickets) return;
    const chosen = tickets.filter((t) => selected.has(t.key));
    const group = chosen.length >= 2;
    setAdding(true);
    setError(null);
    try {
      setDrafts(group ? await api.planAddGroup(chosen) : await api.planAdd(chosen));
      setSelected(new Set());
      setShowPlan(true);
      reloadMarks();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setAdding(false);
    }
  }

  if (showPlan && drafts.length) {
    return (
      <PlanView
        drafts={drafts}
        onChange={setDrafts}
        onBack={() => {
          // 返回不會清掉計畫表：審閱、討論、你改過的內容都留著
          setShowPlan(false);
          reloadMarks();
        }}
        onConfirmed={() => {
          setShowPlan(false);
          reloadMarks();
          onConfirmed();
        }}
      />
    );
  }

  const selectable = tickets?.filter((t) => !locked(marks[t.key])) ?? [];
  const allChecked = selectable.length > 0 && selectable.every((t) => selected.has(t.key));

  return (
    <main>
      <header>
        <div>
          <h1>{t('今日開發任務')}</h1>
          <p className="muted">{t('Jira 上指派給你的單。選擇要列出的狀態，再勾選這次要做的單。')}</p>
        </div>
        <div className="actions">
          <button onClick={() => api.openSettingsFile()}>{t('設定檔')}</button>
          <button onClick={() => refresh()} disabled={loading}>{loading ? t('讀取中…') : t('重新整理')}</button>
        </div>
      </header>

      <div className="status-filter">
        <span className="muted">{t('狀態')}</span>
        {statusOptions.map((status) => (
          <label key={status} className={`chip ${statuses?.includes(status) ? 'on' : ''}`}>
            <input type="checkbox" checked={!!statuses?.includes(status)} onChange={() => toggleStatus(status)} />
            {jiraName(status)}
          </label>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {/* 計畫中的單直接點那一列打開計畫表；只有不在目前篩選裡的，才在這裡留一個入口 */}
      {(() => {
        const hidden = drafts.filter((d) => !tickets?.some((t) => t.key === d.ticket.key));
        return hidden.length > 0 && (
          <p className="muted small plan-hidden">
            {t('計畫表裡還有 {keys}（不在目前選的狀態裡）', { keys: hidden.map((d) => d.ticket.key).join(t('、')) })}
            <button className="link small" onClick={() => setShowPlan(true)}>{t('打開')}</button>
          </p>
        );
      })()}

      {tickets && tickets.length === 0 && !error && <p className="empty">{statuses?.length ? t('選的狀態裡目前沒有單。') : t('請至少選一個狀態。')}</p>}

      {tickets && tickets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th className="check">
                <input
                  type="checkbox"
                  aria-label={t('全選')}
                  checked={allChecked}
                  onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((t) => t.key)))}
                />
              </th>
              <th>{t('單號')}</th>
              <th>{t('標題')}</th>
              <th>{t('主單')}</th>
              <th className="state">{t('狀態')}</th>
              <th>{t('更新')}</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr
                key={ticket.key}
                className={`${selected.has(ticket.key) ? 'selected' : ''} ${locked(marks[ticket.key]) && !marks[ticket.key]?.planning ? 'locked' : ''} ${marks[ticket.key]?.planning ? 'planning' : ''}`}
                onClick={() => (marks[ticket.key]?.planning ? setShowPlan(true) : toggle(ticket.key))}
                title={marks[ticket.key]?.planning ? t('這張單在計畫表裡，點一下打開計畫表') : marks[ticket.key]?.active && !marks[ticket.key]?.done ? t('這張單在工作台上，要在工作台移除後才能再選') : undefined}
              >
                <td className="check">
                  <input type="checkbox" checked={selected.has(ticket.key)} disabled={locked(marks[ticket.key])} onChange={() => toggle(ticket.key)} onClick={(e) => e.stopPropagation()} />
                </td>
                <td className="key">
                  <a href={ticket.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.openExternal(ticket.url); }}>{ticket.key}</a>
                  <span className="tag">{jiraName(ticket.issueType)}</span>
                  <span className="marks">
                    {marks[ticket.key]?.active && (marks[ticket.key].done
                      ? <span className="mark done" title={t('這張單在工作台上已完成；可以再勾選再次開發，確認後舊卡片會收起來')}>{t('已完成')}</span>
                      : <span className="mark active" title={t('這張單正在工作台上進行')}>{t('進行中')}</span>)}
                    {marks[ticket.key]?.planning && <span className="mark planning" title={t('這張單在計畫表裡，還沒確認')}>{t('計畫中')}</span>}
                    {marks[ticket.key]?.branch && !marks[ticket.key]?.active && <span className="mark" title={t('本機已經有這張單的分支，計畫表會讓你選接著做還是開新分支')}>{t('有分支')}</span>}
                  </span>
                </td>
                <td>{ticket.summary}</td>
                <td className="parent">
                  {ticket.parent ? (
                    <>
                      <a href={ticket.parent.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.openExternal(ticket.parent!.url); }}>{ticket.parent.key}</a>
                      <span className="muted">{ticket.parent.summary}</span>
                    </>
                  ) : (
                    <span className="muted">{t('（本身是主單）')}</span>
                  )}
                </td>
                <td className="state">
                  <StatusSwitch
                    ticket={ticket}
                    onChanged={(status) => setTickets((prev) => prev?.map((x) => (x.key === ticket.key ? { ...x, status } : x)) ?? prev)}
                    onError={setError}
                  />
                </td>
                <td className="time">{formatTime(ticket.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer>
        <span className="muted">{t('一次加一個任務：勾一張就是那張；勾好幾張會合成一個任務（同一條分支、一個 PR）。加進計畫表後 AI 在背景審閱，你可以先去做別的。')}</span>
        <button
          className="primary"
          disabled={selected.size === 0 || adding}
          onClick={addToPlan}
          title={selected.size >= 2 ? t('勾好幾張會合成一個任務：同一條分支、同一段 AI 對話、一個 PR') : undefined}
        >
          {adding ? t('加入中…') : selected.size >= 2 ? t('把這 {n} 張合成一個任務，加進計畫表', { n: selected.size }) : t('加進計畫表')}
        </button>
      </footer>
    </main>
  );
}
