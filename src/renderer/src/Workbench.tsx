// 工作台：左邊是你手上的單，中間跟 AI 對話，右邊是測試環境與帳號、本機網站與 Git 改動。
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { BoardState, WorkItem, WorkStatus } from '../../shared/types';
import { ChatPanel, errorText, STATUS_LABEL } from './ChatPanel';
import { PortPanel } from './PortPanel';
import { PrPanel } from './PrPanel';
import { sideName, t, zhOnly } from '../../shared/i18n';
import { term } from './skin';
import { AcceptancePanel, FolderTerminalPanel, GitPanel, pendingChecks, TestPanel } from './SidePanels';

const api = window.flowpilot;

const FINISHED: WorkStatus[] = ['removed', 'committed'];
/** 資料夾已經讓出（可能正在做別張單）：右邊不再顯示會動到資料夾的操作 */
const RELEASED: WorkStatus[] = ['failed', 'stopped', ...FINISHED];

/** 專案的前台／後台（來自設定檔），用來標示這一列做在哪裡 */
const SideContext = createContext<Record<string, string>>({});

function ProjectTag({ item }: { item: WorkItem }) {
  const side = useContext(SideContext)[item.project] ?? '';
  const short = side.split(zhOnly('（'))[0];
  return (
    <span className={`side ${short.startsWith(zhOnly('前台')) ? 'front' : 'back'}`}>
      {short && `${sideName(short)} · `}{item.project}{item.merchant ? ` m${item.merchant}` : ''}
    </span>
  );
}

function Row({ item, selected, onSelect, extra }: { item: WorkItem; selected: boolean; onSelect(): void; extra?: React.ReactNode }) {
  return (
    <li className={`ticket ${selected ? 'selected' : ''} status-${item.status}`} onClick={onSelect}>
      <div className="ticket-line">
        <strong>{item.ticketKey}</strong>
        {item.status !== 'queued' && <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>}
        {item.portOf && <span className="mark" title={t('從 {branch} 移植過來的', { branch: item.portOf.branch })}>{t('移植自 m{merchant}', { merchant: item.portOf.merchant })}</span>}
        {item.members.length > 0 && <span className="mark group" title={item.members.map((m) => `${m.key} ${m.summary}`).join('\n')}>{t('合成 {n} 張', { n: item.members.length })}</span>}
        {item.prs.length > 0 && <span className="mark done" title={item.prs.map((p) => `→ ${p.target || t('？')}`).join('\n')}>{t('已發 PR')}{item.prs.length > 1 ? ` ×${item.prs.length}` : ''}</span>}
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
  // 等你測試時一打開就是驗收表
  const [tab, setTab] = useState<'git' | 'term' | 'report'>(item.testReport && item.stage === 'manual' ? 'report' : 'git');
  const pending = pendingChecks(item);
  // 測試做完、進到等你測試：自動切到驗收
  const readyToCheck = !!item.testReport && item.stage === 'manual';
  useEffect(() => {
    if (readyToCheck) setTab('report');
  }, [readyToCheck]);
  const [changes, setChanges] = useState(0);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  return (
    <>
      <TestPanel item={item} />
      <div className="right-tabs" role="tablist">
        <button role="tab" className={tab === 'git' ? 'on' : ''} onClick={() => setTab('git')}>
          {t('改動')}{changes > 0 && <span className="tab-count">{changes}</span>}
        </button>
        <button role="tab" className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')} title={pending ? t('還有 {n} 項要你測、還沒勾', { n: pending }) : t('每一條需求改了什麼、怎麼測')}>
          {t('驗收')}{pending > 0 && <span className="tab-count">{pending}</span>}
        </button>
        <button role="tab" className={tab === 'term' ? 'on' : ''} onClick={() => setTab('term')} title={siteUrl ? t('本機網站在跑：{url}', { url: siteUrl }) : undefined}>
          {t('本機網站')}{siteUrl && <span className="tab-dot" />}
        </button>
      </div>
      <div className="tab-body" hidden={tab !== 'git'}>
        <GitPanel item={item} onCount={setChanges} />
      </div>
      <div className="tab-body" hidden={tab !== 'report'}>
        <AcceptancePanel item={item} />
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
  // 進行中：已經分到資料夾的（等你回答的排最上面，失敗、停止的也在這裡）；排隊：等專案有空的資料夾；已完成：按過完成、還沒移除的
  const order: WorkStatus[] = ['waiting', 'blocked', 'failed', 'stopped', 'review', 'running', 'preparing', 'parked'];
  const active = items.filter((i) => i.status !== 'queued' && !FINISHED.includes(i.status)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  const waitingTurn = items.filter((i) => i.status === 'queued');
  const finished = items.filter((i) => FINISHED.includes(i.status)).sort((a, b) => b.id - a.id);

  // 預設選對話中的那張；選的那張不見了就換一張；有新的單進來（例如確認計畫後開工）就選到最新的那張
  const known = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!board) return;
    const added = known.current ? items.filter((i) => !known.current!.has(i.id)) : [];
    known.current = new Set(items.map((i) => i.id));
    if (added.length) setSelected(Math.max(...added.map((i) => i.id)));
    else if (selected === null || !items.some((i) => i.id === selected)) setSelected(active[0]?.id ?? waitingTurn[0]?.id ?? null);
  }, [board]);

  const current = items.find((i) => i.id === selected) ?? null;

  return (
    <SideContext.Provider value={sides}>
    <div className="workbench">
      <aside className="sidebar">
        {board?.pendingRun && (
          <div className="pending-run small">
            {t('有確認好、還沒開始的計畫（{keys}）', { keys: board.pendingRun.ticketKeys.join(t('、')) })}
            <button className="primary" onClick={() => api.startRun(board.pendingRun!.id).catch((e) => setError(errorText(e)))}>{t('開始')}</button>
          </div>
        )}
        {error && <div className="error small">{error}</div>}

        <div className="side-section">{t('{label}（{n}）', { label: term(zhOnly('進行中')), n: active.length })}</div>
        <ul className="tickets">
          {active.length === 0 && <li className="muted small empty-row">{t('沒有')}</li>}
          {active.map((i) => (
            <Row key={i.id} item={i} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
          ))}
        </ul>

        {waitingTurn.length > 0 && (
          <>
            <div className="side-section">{t('{label}（{n}）', { label: term(zhOnly('排隊')), n: waitingTurn.length })}</div>
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
                        if (window.confirm(t('從排隊中移除 {key}？還沒開始，不會動到任何檔案或分支。', { key: i.ticketKey }))) api.remove(i.id).catch((err) => setError(errorText(err)));
                      }}
                    >
                      {t('移除')}
                    </button>
                  }
                />
              ))}
            </ul>
          </>
        )}

        {finished.length > 0 && (
          <>
            <div className="side-section">{t('{label}（{n}）', { label: term(zhOnly('已完成')), n: finished.length })}</div>
            <ul className="tickets">
              {finished.map((i) => (
                <Row key={i.id} item={i} selected={selected === i.id} onSelect={() => setSelected(i.id)} />
              ))}
            </ul>
          </>
        )}

      </aside>

      <main className="center">
        {current ? (
          <ChatPanel key={current.id} item={current} />
        ) : (
          <div className="empty-state">
            <p>{t('還沒有正在處理的單。到「單列表」勾選單、確認計畫後就會出現在這裡。')}</p>
            <button className="primary" onClick={onGoTickets}>{t('到單列表')}</button>
          </div>
        )}
      </main>

      <aside className="right">
        {current?.status === 'parked' ? (
          // 待補測：不佔資料夾，驗收表照樣能勾、能匯出，也能發 PR；要修就按標題列的「繼續修」
          <>
            <div className="panel finished-note">
              <strong>{t('先交付了，待補測 {n} 項', { n: pendingChecks(current) })}</strong>
              <p className="muted small">{t('資料夾已經讓出，分支、提交、對話都留著。補測完勾「我測過了」，全部勾完才能完成；要修時按上方的「繼續修」（資料夾都在用時會告訴你哪張單在用）。')}</p>
              <p className="small">{t('分支：')}<code>{current.branch}</code></p>
            </div>
            <AcceptancePanel item={current} />
            <PrPanel key={current.id} item={current} />
          </>
        ) : current && ['failed', 'stopped'].includes(current.status) ? (
          <div className="panel finished-note">
            <strong>{t('這張單停下來了')}</strong>
            <p className="muted small">{t('資料夾 {folder} 已經讓出，可能正在做別張單。按「重試」會重新分配資料夾接著做；不做了可以從「更多 → 移除」拿掉。', { folder: current.folder ?? '—' })}</p>
            <p className="small">{t('分支：')}<code>{current.branch}</code></p>
          </div>
        ) : current && RELEASED.includes(current.status) ? (
          // 已結束的單：資料夾可能已經是別張單在用，這裡不再提供會動到資料夾的操作
          <>
          <div className="panel finished-note">
            <strong>{t('這張單已完成')}</strong>
            <p className="muted small">
              {t('資料夾 {folder} 已經讓出，可能正在做別張單，所以這裡不再顯示環境切換、終端機和改動。', { folder: current.folder ?? '—' })}
            </p>
            <p className="muted small">{t('確定不用再改了，可以從「更多 → 移除」把它從工作台拿掉：會刪掉本機分支（遠端分支不動），單列表上的「已完成」標籤也會消失。')}</p>
            <p className="small">{t('分支：')}<code>{current.branch}</code></p>
            {current.activity && <p className="muted small">{current.activity}</p>}
          </div>
          {current.status === 'committed' && <PortPanel item={current} all={items} />}
          {current.status === 'committed' && <PrPanel key={current.id} item={current} />}
          </>
        ) : current?.folder ? (
          <RightPanels key={current.id} item={current} />
        ) : current ? (
          <p className="muted small">{t('這張單分配到資料夾之後，這裡會顯示終端機與 Git 改動。')}</p>
        ) : null}
      </aside>
    </div>
    </SideContext.Provider>
  );
}
