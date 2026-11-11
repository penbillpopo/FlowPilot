// 工作台中間：跟 AI 對話。完整的對話紀錄（思考、指令、改動、工具）、即時更新、輸入框（可貼截圖）。
import { Fragment, useEffect, useRef, useState } from 'react';
import type { BranchInfo, ChatEntry, ChatEvent, I18nProgress, WorkItem, WorkStage, WorkStatus } from '../../shared/types';
import { t, zhOnly } from '../../shared/i18n';
import { DiffView } from './DiffView';
import { commitPrefs, deliveryOf, gitChanged, useGitState } from './delivery';
import { appendPaths, useImageAttach } from './ImageAttach';
import { Markdown } from './Markdown';
import { pendingChecks } from './SidePanels';
import { statusLabel, term } from './skin';

const api = window.flowpilot;

/** 狀態文字（開了指揮官用語會換成作戰用語） */
export const STATUS_LABEL = new Proxy({} as Record<WorkStatus, string>, { get: (_t, key) => statusLabel(key as WorkStatus) });

/** 流程：審閱 ✓ → 開發 → 自動測試 → 等你測試（修改、重測都算在等你測試這一步）→ 交付（提交過之後：推送、完成） */
// i18n-keys：顯示時才翻
const STEPS = ['審閱', '開發', '自動測試', '等你測試', '交付'];
const STEP_OF: Record<WorkStage, number> = { develop: 1, selfcheck: 1, speccheck: 1, autotest: 2, manual: 3, fix: 3, retest: 3 };
// i18n-keys：顯示時才翻
const RUNNING_NOTE: Record<WorkStage, string> = { develop: 'AI 開發中', selfcheck: 'AI 自我審查中', speccheck: 'AI 比對規格中', autotest: 'AI 測試中', manual: 'AI 處理中', fix: 'AI 修改中', retest: 'AI 重測中' };

/** 目前這一步在等什麼（合併原本的狀態標籤）；空字串代表不用多說明 */
function stepNote(item: WorkItem): string {
  switch (item.status) {
    case 'running':
      return t(RUNNING_NOTE[item.stage]);
    case 'waiting':
      return item.pending?.kind === 'approval' ? t('等你同意') : item.pending?.kind === 'decision' ? t('等你決定') : t('要你回答');
    case 'review':
      return '';
    default:
      return STATUS_LABEL[item.status];
  }
}

function Stages({ item, delivering }: { item: WorkItem; delivering: boolean }) {
  const current = delivering && item.stage === 'manual' ? 4 : STEP_OF[item.stage] ?? 1;
  const finished = item.status === 'committed';
  const note = stepNote(item);
  const tone = ['waiting', 'blocked'].includes(item.status) ? 'attn' : ['failed', 'stopped'].includes(item.status) ? 'bad' : '';
  return (
    <ol className="stages">
      {STEPS.map((label, i) => {
        const done = finished || i < current;
        const now = !finished && i === current;
        // 自動測試：照結果顯示，沒測成、部分通過、看不出來都不打勾；沒跑過（舊單）顯示略過
        const result = done && i === 2 ? autotestMark(item) : null;
        return (
          <li key={label} className={result ? result.className : done ? 'done' : now ? `now ${tone}` : ''} title={result?.title}>
            {t(term(label))}
            {result ? result.text : done ? ' ✓' : ''}
            {now && (i === 4 && item.status === 'review' ? <span className="step-note">・{t('推送、完成')}</span> : note && <span className="step-note">・{note}</span>)}
          </li>
        );
      })}
    </ol>
  );
}

/** 自動測試那一格怎麼顯示 */
function autotestMark(item: WorkItem): { text: string; className: string; title?: string } | null {
  const r = item.autotestResult;
  if (!r) return item.autotested ? null : { text: t('（略過）'), className: 'skipped' };
  if (r.kind === 'passed') return null; // 照一般的打勾
  if (r.kind === 'partial') return { text: t('（部分通過）'), className: 'partial', title: r.reason };
  if (r.kind === 'failed') return { text: t('（沒測成）'), className: 'failed', title: r.reason };
  return { text: t('（看結果）'), className: 'partial', title: t('測試的 AI 沒有寫出結果，請看對話裡最後的報告') };
}

/** FlowPilot 自動交給 AI 的訊息（開發、測試指示、更新需求），不是你打的字 */
function flowPilotLabel(text: string): string | null {
  const skill = text.match(/^［技能：(.+?)］/)?.[1];
  if (skill) {
    const kind = text.includes(zhOnly('開瀏覽器重新測試')) ? t('重測指示') : text.includes(zhOnly('自動安排的測試')) ? t('自動測試指示') : text.includes(zhOnly('移植到商戶')) ? t('移植指示') : t('開發指示');
    return t('{kind}（{skill}）', { kind, skill });
  }
  if (text.startsWith(zhOnly('## 更新需求'))) return t('更新需求');
  if (text.startsWith(zhOnly('## 自我審查'))) return t('自我審查指示');
  if (text.startsWith(zhOnly('## 規格比對'))) return t('規格比對找到做錯的地方，請 AI 確認、修正');
  if (text.startsWith(zhOnly('## 整理驗收表'))) return t('整理驗收表指示');
  if (text.startsWith(zhOnly('## 修編譯錯誤'))) return t('本機網站編譯失敗，請 AI 修正（點開看錯誤）');
  if (text.startsWith(zhOnly('## 換新對話'))) return t('對話太長，整理重點後換新對話（點開看交接內容）');
  if (text.startsWith(zhOnly('## 多語系 key 重複'))) return t('多語系 key 重複，請 AI 換名字');
  if (text.startsWith(zhOnly('## 同步基底分支'))) return t('同步基底分支有衝突，請 AI 解衝突');
  if (text.startsWith(zhOnly('## 繼續改多語系'))) return t('多語系還沒做完，請 AI 繼續');
  if (text.startsWith(zhOnly('## 接上你的 Chrome'))) return t('接上你的 Chrome（Chrome 會跳出頁面讓你選分頁）');
  if (text.startsWith(zhOnly('## 看我的畫面'))) {
    const ask = text.match(/^我想問：(.+)$/m)?.[1];
    return ask ? t('看你開的畫面：{ask}', { ask }) : t('看你開的畫面');
  }
  if (text.trim() === zhOnly('請從剛才中斷的地方繼續。')) return t('請 AI 從中斷的地方繼續');
  return null;
}

/**
 * 移除的確認視窗：移除就是回到從沒做過的樣子——刪本機分支（遠端不動）、資料夾還原、審閱紀錄刪掉。
 * 會遺失的東西（沒推送的提交、沒提交的改動）用紅字列出來，你確定才移除。
 */
function RemoveDialog({ item, onClose }: { item: WorkItem; onClose(): void }) {
  const [info, setInfo] = useState<BranchInfo | null | undefined>(item.folder ? undefined : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = ['running', 'preparing'].includes(item.status);

  useEffect(() => {
    if (item.folder) api.branchInfo(item.id).then(setInfo).catch((e) => (setInfo(null), setError(t('讀不到分支狀況：{error}', { error: errorText(e) }))));
  }, [item.id]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.remove(item.id);
      if (info?.exists && !result.branchDeleted) window.alert(t('已從工作台移除 {key}，但本機分支沒有刪成：{reason}', { key: item.ticketKey, reason: result.reason ?? t('原因不明') }));
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t('從工作台移除 {key}？', { key: item.ticketKey })}</h3>
        <p className="muted small">
          {item.project}{item.merchant ? ` m${item.merchant}` : ''} · <code>{item.branch}</code>
        </p>
        {running ? (
          <p className="warn small">{t('AI 還在執行，請先按「中斷這一輪」，停下來之後再移除。')}</p>
        ) : (
          <>
            <p className="small">{t('移除就是回到從沒做過的樣子：')}</p>
            <ul className="modal-notes small">
              {info?.exists && <li>{t('刪掉本機分支')} <code>{info.branch}</code>{t('；{folder} 停在這條分支上的話，會切回 {base}。', { folder: String(item.folder), base: info.baseBranch })}</li>}
              <li><strong>{t('遠端分支不會動')}</strong>{info?.hasRemote ? t('（遠端有這條分支，要刪請你自己刪）') : ''}{t('。')}</li>
              <li>{t('審閱紀錄刪掉，單列表上的標籤也會消失；要重新做，從單列表再選一次。')}</li>
            </ul>
            {info === undefined && <p className="muted small">{t('讀取分支狀況中…')}</p>}
            {info && (info.unpushed === null || info.unpushed > 0 || info.dirty.length > 0) && (
              <ul className="modal-notes small">
                {info.unpushed === null && <li className="danger-text">{t('算不出有幾個提交還沒推送；移除後，這些提交可能就沒了。')}</li>}
                {!!info.unpushed && <li className="danger-text">{t('有 {count} 個提交還沒推送，移除後就沒了。', { count: info.unpushed })}</li>}
                {info.dirty.length > 0 && (
                  <li className="danger-text">
                    {t('有 {count} 個沒提交的改動會被丟掉：{files}', { count: info.dirty.length, files: info.dirty.slice(0, 5).join(t('、')) })}{info.dirty.length > 5 ? t(' 等') : ''}
                  </li>
                )}
              </ul>
            )}
          </>
        )}
        {error && <div className="error small">{error}</div>}
        <div className="row modal-actions">
          <button disabled={busy} onClick={onClose}>{t('取消')}</button>
          <button className="danger-solid" disabled={busy || running || info === undefined} onClick={confirm}>
            {busy ? t('處理中…') : t('移除')}
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
          <Collapsible title={<span><span className="fp-tag">FlowPilot</span> {entry.text.startsWith(zhOnly('## 換新對話')) ? label : entry.text.startsWith(zhOnly('## 看我的畫面')) || entry.text.startsWith(zhOnly('## 接上你的 Chrome')) ? t('請 AI {label}', { label }) : t('交給 AI 的{label}', { label })}</span>} tone="soft flowpilot">
            <Markdown text={entry.text} />
          </Collapsible>
        );
      return (
        <div className="msg user">
          <Markdown text={entry.text} />
          {!!entry.images?.length && <div className="muted small">{t('附上 {count} 張截圖', { count: entry.images.length })}</div>}
        </div>
      );
    }
    case 'assistant':
      return (
        <div className="msg assistant">
          {/* 驗收表的 JSON 畫在右邊「驗收」，對話裡只留一句 */}
          <Markdown text={entry.text.replace(/```flowpilot-test[\s\S]*?(```|$)/g, t('_（驗收表已更新，看右邊「驗收」）_')).replace(/```flowpilot-spec[\s\S]*?(```|$)/g, t('_（規格比對的處理結果已記下，看右邊「驗收」）_')).replace(/^.*多語系進度[：:].*$/gm, '').trimEnd()} />
        </div>
      );
    case 'reasoning':
      return entry.text ? (
        <Collapsible title={<span className="muted">{t('思考')}</span>} tone="soft">
          <Markdown text={entry.text} className="muted" />
        </Collapsible>
      ) : null;
    case 'plan':
      return (
        <Collapsible title={t('計畫')} open tone="soft">
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
              <span className="muted">{running ? t('執行中') : failed ? t('失敗（{code}）', { code: entry.exitCode ?? '—' }) : t('執行')}</span> <code>{(entry.command ?? '').replace(/^\/bin\/zsh -lc /, '')}</code>
            </span>
          }
        >
          <pre className="output">{entry.output || t('（沒有輸出）')}</pre>
        </Collapsible>
      );
    }
    case 'fileChange':
      return (
        <Collapsible title={<span>{t('改了 {count} 個檔案', { count: entry.files?.length ?? 0 })}{entry.status === 'declined' ? t('（被拒絕）') : ''}</span>} open>
          {(entry.files ?? []).map((f) => (
            <Collapsible key={f.path} title={<code>{f.path}</code>} tone="soft">
              <DiffView diff={f.diff} />
            </Collapsible>
          ))}
        </Collapsible>
      );
    case 'tool':
      return (
        <Collapsible title={<span><span className="muted">{t('工具')}</span> {entry.text}</span>} tone={entry.status === 'failed' ? 'bad' : ''}>
          <pre className="output">{entry.output || t('（沒有輸出）')}</pre>
        </Collapsible>
      );
    case 'search':
      return <div className="muted small">{t('搜尋：{text}', { text: entry.text })}</div>;
    default:
      return <div className="muted small">— {entry.text} —</div>;
  }
}

/** 改多語系的進度：放在對話最後，跟 AI 正在跑的指令分開顯示，不會被蓋掉 */
function I18nBar({ id, progress }: { id: number; progress: I18nProgress }) {
  const { phase, count, batches, file, note } = progress;
  const text =
    phase === 'working' ? t('AI 正在改寫死的文字（已記下 {count} 條）', { count })
    : phase === 'paused' ? t('還沒做完，AI 停下來了（已記下 {count} 條）：要它接著做，就跟它說「繼續改多語系」', { count })
    : phase === 'translating' ? t('AI 改完了，FlowPilot 翻譯其他語言中（{done}/{total} 批，共 {count} 條）', { done: batches?.done ?? 0, total: batches?.total ?? 0, count })
    : phase === 'saved' ? (note ? t('{count} 條已存到桌面 {file}（{note}）', { count, file: String(file), note }) : t('{count} 條已存到桌面 {file}', { count, file: String(file) }))
    : t('翻譯失敗：{note}（已記下的 {count} 條還在，AI 說做完時會重新翻）', { note: String(note), count });
  return (
    <div className={`i18n-bar ${phase}`}>
      {(phase === 'working' || phase === 'translating') && <span className="spinner" />}
      <span className="fp-tag">{t('多語系')}</span>
      <span>{text}</span>
      {phase === 'saved' && (
        <button className="link small push-right" onClick={() => api.revealI18n(id)}>
          {t('在 Finder 顯示')}
        </button>
      )}
    </div>
  );
}

/** 哪些單開著「看我的」模式（放在元件外面，換單再回來還記得） */
const lookModeOn = new Set<number>();

export function ChatPanel({ item }: { item: WorkItem }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  // 對話不放「附圖」按鈕（你不用）：截圖、拖曳、貼上照樣可以附圖
  const attach = useImageAttach({ onPaths: (paths) => setText((prev) => appendPaths(prev, paths)), noPicker: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 分析報告的進度（產生中才有）；換單再回來也接得上 */
  const [reportProgress, setReportProgress] = useState<string | null>(null);
  useEffect(() => api.test.onReportProgress((id, text) => id === item.id && setReportProgress(text || null)), [item.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  // 右邊「改動」的「跟 AI 說」：把檔名帶進輸入框，接著打要怎麼改
  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setText((prev) => (prev.trim() ? `${prev}\n${detail}` : detail));
      setTimeout(() => input.current?.focus(), 0);
    };
    window.addEventListener('flowpilot:ask-ai', onAsk);
    return () => window.removeEventListener('flowpilot:ask-ai', onAsk);
  }, []);

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
        .catch((e) => !cancelled && setError(t('讀取對話紀錄失敗：{error}', { error: errorText(e) })))
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

  // 「已提交」這類回饋幾秒後自動消失
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /** 「看我的」模式：右邊按了之後一直開著（換單再回來也還在），這段期間你說的每句話都是要 AI 去看你在 Chrome 選的畫面；按 × 才關 */
  const [lookMode, setLookModeState] = useState(() => lookModeOn.has(item.id));
  const setLookMode = (on: boolean) => {
    if (on) lookModeOn.add(item.id);
    else lookModeOn.delete(item.id);
    setLookModeState(on);
  };
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== item.id) return;
      setLookMode(true);
      input.current?.focus();
      // Chrome 選分頁的頁面只有在共用瀏覽器第一次用時才會跳出來：先換一個全新的共用瀏覽器（舊的可能還佔著 Chrome），再請 AI 只接上、不做別的
      // 傳單號：重開後等這段對話看得到共用瀏覽器的工具才叫 AI 接（以前馬上叫，工具還沒載入好就回「接不上」）
      api
        .resetSharedBrowser(item.id)
        .then(() => api.send(
          item.id,
          [
            zhOnly('## 接上你的 Chrome'),
            zhOnly("在 exec 裡呼叫一次 tools.mcp__flowpilot_shared_browser__browser_tabs({ action: 'list' })（共用瀏覽器的列出分頁），讓 Chrome 跳出頁面讓我選分頁。"),
            zhOnly('接上後只回一句「接上了」，不要截圖、不要看頁面、不要做任何別的事，等我接著說要看什麼。'),
            zhOnly('只能用 flowpilot_shared_browser，不要用其他瀏覽器或控制電腦的工具代替。工具清單上看不到它是正常的，它在 exec 的 tools 裡。'),
            zhOnly('剛重新啟動，工具可能還在載入：呼叫時說「is not a function」或找不到工具，就等 5 秒再呼叫一次（每次重新呼叫 exec），最多試 3 次；3 次都失敗才照實回「接不上」和錯誤訊息。'),
          ].join('\n'),
          [],
        ))
        .catch((err) => setError(errorText(err)));
    };
    window.addEventListener('flowpilot:look', on);
    return () => window.removeEventListener('flowpilot:look', on);
  }, [item.id]);

  async function send() {
    if (!text.trim() && attach.images.length === 0) return;
    // 用「## 看我的畫面」開頭：對話裡顯示成 FlowPilot 的動作標籤，不是一大段你打的話
    const message = lookMode
      ? [
          zhOnly('## 看我的畫面'),
          zhOnly('我開著「看我的」模式：我說的話是在講我在 Chrome 開的畫面。先用共用瀏覽器（flowpilot_shared_browser）看我選給你的分頁現在的樣子（不要用之前看過的），再照我這句話做。呼叫時說「is not a function」是工具還在載入，等 5 秒再試，最多 3 次。'),
          zhOnly(`我想問：${text.trim()}`),
          zhOnly('照我這句話決定做多少：只是問問題，就看完回答；要你測，就在這個分頁親自點擊、填寫、捲動、切換頁面去測，測完說結果。'),
          zhOnly('共用瀏覽器沒有寫入防護，資料會真的寫進去：會存檔、送出、刪除、下注、儲值、改設定這類寫入的動作，先問我再做。要大量或完整測試時，也可以改用測試瀏覽器（有寫入防護），用之前跟我說一聲。'),
          zhOnly('操作我的畫面要用 flowpilot_shared_browser（在 exec 裡用 tools.mcp__flowpilot_shared_browser__browser_snapshot、browser_click 這類名稱呼叫），不要用其他控制電腦的工具代替；呼叫失敗就照實說接不上和錯誤訊息。我這句話沒叫你改程式，就不要改程式碼。'),
        ].join('\n')
      : text;
    const attached = attach.images;
    await act(async () => {
      await api.send(item.id, message, attached);
      setText('');
      attach.clear();
      stick.current = true;
    });
  }


  const running = item.status === 'running';
  /** 多語系進度排在哪一則訊息後面：開始時間之前的最後一則（-1 是排在最前面） */
  const i18nAt = item.i18n ? entries.findLastIndex((e) => (e.at ?? 0) <= item.i18n!.at) : -1;

  async function finish() {
    // 還有提交沒推送就先提醒（照平常的流程，推送後才算完成）
    let unpushed = 0;
    let empty = false;
    try {
      const git = await api.git.state(item.id);
      unpushed = git.hasRemote ? (git.unpushed ?? 0) : git.ahead;
      // 比基底沒有多任何提交、也沒有沒提交的改動：這張單其實什麼都沒做（實際發生過：AI 停下來沒開發，卻被按了完成）
      const changes = [...git.staged, ...git.unstaged].filter((f) => !/(^|\/)src\/environments\/environment[^/]*\.ts$/.test(f.path));
      empty = git.branch === item.branch && git.ahead === 0 && changes.length === 0;
    } catch {}
    const pending = pendingChecks(item);
    const warning =
      (empty ? '\n\n' + t('🛑 這張單沒有任何改動：{branch} 比 {base} 沒有多任何提交。AI 可能沒有真的開發（看一下對話裡它說的原因）。', { branch: item.branch, base: String(item.baseBranch) }) : '') +
      (unpushed > 0 ? '\n\n' + t('⚠️ 還有 {count} 個提交沒推送。完成之後還是可以推送，但要記得。', { count: unpushed }) : '') +
      (pending ? '\n\n' + t('⚠️ 驗收表還有 {count} 項要你測、還沒勾「我測過了」。', { count: pending }) : '');
    const ok = window.confirm(
      t('完成 {key}，讓出 {folder} 給下一張？', { key: item.ticketKey, folder: String(item.folder) }) +
        warning +
        '\n\n' +
        t('資料夾要乾淨（改動都提交或捨棄了）；environment.ts（瀏覽器測試切 SIT／UAT 用的）會順便還原，本機網站也會停掉。'),
    );
    if (ok) act(() => api.finish(item.id, true));
  }
  const active = !['committed', 'removed'].includes(item.status);
  // 交付：標題列的主要按鈕照進度變成「提交 → 推送 → 完成這張單」
  const { state: git } = useGitState(item, active && !!item.threadId);
  const delivery = deliveryOf(item, git);
  // 資料夾被切到別的分支（例如你在 VS Code 切走了）：整張卡片鎖住，主要按鈕變成切回（退役的資料夾是搬走，不切你的資料夾）
  const offBranch = active && !!item.folder && !!git && git.branch !== item.branch;
  const fixBranch = !offBranch || !git
    ? null
    : git.retired
      ? {
          label: t('搬到 FlowPilot 的資料夾繼續'),
          title: t('{folder} 是你自己也在用的資料夾，不切它；把這張單搬到 FlowPilot 專用的資料夾，接著原本的對話', { folder: String(item.folder) }),
          run: () => {
            const message =
              t('把 {key} 搬到 FlowPilot 的資料夾繼續？', { key: item.ticketKey }) +
              '\n\n' +
              t('{folder} 留在 {current}，不會動到；分支 {branch} 沒推送的提交會一起帶過去，對話和驗收表照舊。', { folder: String(item.folder), current: git.branch || t('（不在任何分支）'), branch: item.branch });
            if (window.confirm(message)) act(async () => {
              await api.relocate(item.id);
              gitChanged();
            });
          },
        }
      : {
          label: t('切回 {branch}', { branch: item.branch }),
          title: t('把資料夾 {folder} 切回這張單的分支；有沒提交的改動會先告訴你是哪些', { folder: String(item.folder) }),
          run: () => act(async () => {
            await api.switchBack(item.id);
            gitChanged();
          }),
        };
  const canDeliver = active && !!item.folder && !!item.threadId && ['review', 'waiting'].includes(item.status) && !item.pending?.kind?.match(/approval|decision/);
  // 欠的測試：還有沒勾「我測過了」的，不能完成，只能「先交付，待補測」
  const owed = pendingChecks(item);
  const parkStep = {
    label: t('先交付，待補測（{count} 項）', { count: owed }),
    title: t('改動都提交了、測試還沒測完：讓出資料夾給下一張，欠的測試留著；要修時按「繼續修」'),
    run: () => {
      const message =
        t('先交付 {key}，讓出 {folder}？', { key: item.ticketKey, folder: String(item.folder) }) +
        '\n\n' +
        t('還有 {count} 項測試沒勾，會一直留在驗收表上，補測完才能完成。', { count: owed }) +
        '\n' +
        t('可以先發 PR；要修的時候按「繼續修」，會重新拿一個資料夾、接著原本的對話。');
      if (window.confirm(message)) act(() => api.park(item.id));
    },
  };
  let next: { label: string; title?: string; run(): void } | null = null;
  if (canDeliver && delivery?.onBranch && git) {
    if (delivery.changes.length) {
      next = {
        label: busy ? t('提交中…') : t('提交 {count} 個檔案', { count: delivery.changes.length }),
        title: t('把 AI 的改動提交到這張單的分支（專案的提交前檢查可能要等幾十秒）；提交訊息可以在右邊「改動」修改'),
        run: () => act(async () => {
          const prefs = commitPrefs(item.id);
          const result = await api.git.commitAll(item.id, prefs.message ?? item.prTitle, prefs.who ?? undefined);
          gitChanged();
          setNotice(t('已提交（{sha}）', { sha: result.sha }) + (result.restored.length ? t('；提交前檢查順手改到的 {count} 個無關檔案已還原', { count: result.restored.length }) : ''));
        }),
      };
    } else if (delivery.pushCount > 0) {
      const count = delivery.pushCount;
      next = {
        label: busy ? t('推送中…') : git.needsForce ? t('強制推送 {count} 個提交', { count }) : t('推送 {count} 個提交', { count }),
        title: git.needsForce ? t('分支 rebase 過，跟遠端的歷史不一樣，會用 --force-with-lease 推送') : git.hasRemote ? undefined : t('遠端還沒有這條分支，推送時會建立'),
        run: () => {
          const what = git.needsForce
            ? t('遠端的 {branch} 跟本機的歷史不一樣（rebase 過），要強制推送嗎？', { branch: item.branch }) + '\n\n' + t('會用 --force-with-lease：遠端被別人推了新的提交時會拒絕覆蓋。')
            : git.hasRemote
              ? t('推送 {count} 個提交到遠端的 {branch}？', { count, branch: item.branch })
              : t('推送 {count} 個提交到遠端的 {branch}（建立遠端分支）？', { count, branch: item.branch });
          if (window.confirm(what)) act(async () => {
            await api.git.push(item.id);
            gitChanged();
            setNotice(t('已推送'));
          });
        },
      };
    } else if (item.status === 'review') {
      next = owed ? parkStep : { label: t('完成這張單'), run: finish };
    }
  } else if (item.status === 'review' && item.folder) {
    next = owed ? parkStep : { label: t('完成這張單'), run: finish };
  } else if (item.status === 'parked') {
    // 待補測：補測完就可以完成；要修就「繼續修」（拿資料夾）
    next = owed ? { label: t('繼續修'), title: t('拿一個空的資料夾、切回這條分支，接著原本的對話'), run: () => act(() => api.resume(item.id)) } : { label: t('完成這張單'), run: finish };
  }
  if (fixBranch) next = fixBranch;
  // 自動測試沒測成或看不出結果時，處理好之後可以再跑一次
  const canRerun = active && !offBranch && !!item.threadId && item.stage === 'manual' && ['review', 'waiting'].includes(item.status) && !item.pending && !!item.autotestResult && item.autotestResult.kind !== 'passed';
  const canRetest = active && !offBranch && !!item.threadId && item.stage === 'manual' && ['review', 'waiting'].includes(item.status) && !item.pending;
  // AI 在等你回話（問問題、被中斷、或有事要你處理）：輸入框加醒目外框
  const awaitingYou = item.status === 'waiting' && (!item.pending || item.pending.kind === 'userInput');
  const canSend = !!item.threadId && active && !offBranch && !['queued', 'preparing', 'parked'].includes(item.status) && item.pending?.kind !== 'approval' && item.pending?.kind !== 'decision';

  return (
    <section className="chat">
      {removing && <RemoveDialog item={item} onClose={() => setRemoving(false)} />}
      <div className="chat-head">
        <div className="chat-head-top">
        <div className="chat-title">
          {/* 開始對話前沒有階段可看，才顯示狀態 */}
          {!item.threadId && <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>}
          <strong>{item.ticketKey}</strong>
          {item.members.length > 0 && (
            <span className="mark group" title={item.members.map((m) => `${m.key} ${m.summary}`).join('\n')}>
              {t('＋')}{item.members.filter((m) => m.key !== item.ticketKey).map((m) => m.key).join(t('、'))}
            </span>
          )}
          <span className="item-title" title={item.ticketSummary}>{item.ticketSummary}</span>
        </div>
        <div className="row head-actions">
          {running && <button disabled={busy} onClick={() => act(() => api.interrupt(item.id))}>{t('中斷這一輪')}</button>}
          {next && (
            <button className="primary" disabled={busy} onClick={next.run} title={next.title}>
              {next.label}
            </button>
          )}
          {['blocked', 'failed', 'stopped'].includes(item.status) && <button disabled={busy} onClick={() => act(() => api.retry(item.id))}>{t('重試')}</button>}
          {item.status !== 'removed' && (
            <details className="more">
              <summary>{t('更多')}</summary>
              <div className="more-menu">
                {/* 重跑自動測試：可以選用真實資料（後端要好了）或假資料（後端還沒好，AI 自己產生假的 API 回應） */}
                {(canRerun || canRetest) && (
                  <>
                    <button
                      disabled={busy}
                      title={lookMode ? t('看我的模式開著：用你在 Chrome 選的分頁測，打真的後端（寫入資料前會先問你）') : t('用無頭瀏覽器再跑一次自動測試，打真的後端')}
                      onClick={(e) => {
                        e.currentTarget.closest('details')?.removeAttribute('open');
                        act(async () => {
                          stick.current = true;
                          await api.rerunAutotest(item.id, false, lookMode);
                        });
                      }}
                    >
                      {t('重跑自動測試（真實資料）')}
                    </button>
                    <button
                      disabled={busy}
                      title={lookMode ? t('看我的模式開著：用你在 Chrome 選的分頁、假資料測（只攔這個分頁的請求，測完會拿掉）') : t('後端還沒好時用：AI 自己判斷哪些 API 還沒好、產生假資料來測；用到假資料的項目，後端好了要重測')}
                      onClick={(e) => {
                        e.currentTarget.closest('details')?.removeAttribute('open');
                        act(async () => {
                          stick.current = true;
                          await api.rerunAutotest(item.id, true, lookMode);
                        });
                      }}
                    >
                      {t('重跑自動測試（假資料）')}
                    </button>
                  </>
                )}
                {canRetest && (
                  <button
                    disabled={busy}
                    title={t('後端還沒好時用：AI 先列測試計畫給你確認，再開瀏覽器用假資料測給你看')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.retest(item.id, true);
                      });
                    }}
                  >
                    {t('開瀏覽器測給我看（假資料）')}
                  </button>
                )}
                {/* 開瀏覽器測給我看：不放標題列（你很少用），收在這裡 */}
                {canRetest && (
                  <button
                    disabled={busy}
                    title={t('AI 先列測試計畫給你確認，再開瀏覽器測給你看（用測試帳號自動登入）')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.retest(item.id);
                      });
                    }}
                  >
                    {t('開瀏覽器測給我看')}
                  </button>
                )}
                {active && item.threadId && (
                  <button
                    disabled={busy || running || offBranch}
                    title={running ? t('AI 執行中，等它停下來再更新需求') : t('重新讀 Jira，跟上次的內容比對，請 AI 在對話裡說明有沒有變更、打算怎麼改')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.requestRequirementUpdate(item.id);
                      });
                    }}
                  >
                    {t('更新需求')}
                  </button>
                )}
                {/* 走規格流程的單：改過之後再拿規格比對一次（做錯的交給 AI 修，修完回到等你測試） */}
                {canRetest && item.specCheck && (
                  <button
                    disabled={busy}
                    title={t('請沒看過開發過程的 AI 再拿開工前的規格比對一次目前的改動；做錯的交給 AI 修')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(async () => {
                        stick.current = true;
                        await api.rerunSpecCheck(item.id);
                      });
                    }}
                  >
                    {t('再比對一次規格')}
                  </button>
                )}
                {active && item.threadId && item.folder && <button onClick={() => act(() => api.openInVSCode(item.id))}>{t('在 VS Code 查看')}</button>}
                {active && item.threadId && item.folder && !offBranch && (
                  <button
                    disabled={busy || running}
                    title={t('把這張單的分支 rebase 到最新的 {base}（沒提交的修改會先收起來、做完放回；有衝突交給 AI 解）', { base: item.baseBranch })}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      act(() => api.syncBase(item.id));
                    }}
                  >
                    {t('同步基底分支')}
                  </button>
                )}
                {/* 測試完成後：產生分析報告（截改動前後、整理重點，存成桌面的 PDF；要幾分鐘，背景跑） */}
                {item.testReport && !running && item.status !== 'preparing' && (
                  <button
                    disabled={!!reportProgress}
                    title={t('整理這張單要做什麼、改動前後、測試時的截圖、重點和驗收結果，存成桌面的 PDF（大約一兩分鐘）')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      setReportProgress(t('準備中'));
                      api.test
                        .report(item.id)
                        .then((file) => setNotice(t('分析報告存到 {file}', { file })))
                        .catch((err) => setError(errorText(err)))
                        .finally(() => setReportProgress(null));
                    }}
                  >
                    {reportProgress ? t('報告產生中…') : t('產生分析報告')}
                  </button>
                )}
                {active && !offBranch && item.status !== 'review' && !running && item.status !== 'preparing' && item.folder && (
                  <button onClick={finish} disabled={!!owed} title={owed ? t('還有 {count} 項測試沒勾，補測完才能完成', { count: owed }) : undefined}>{t('完成這張單')}</button>
                )}
                {/* 還有沒測的項目時：可以不補測直接完成（平常的按鈕照舊要測完；沒測的記在驗收表上） */}
                {!!owed && !offBranch && !running && item.status !== 'preparing' && ['review', 'waiting', 'parked'].includes(item.status) && (
                  <button
                    disabled={busy}
                    title={t('不補測直接完成這張單；還沒測的項目會記在驗收表上')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      if (window.confirm(t('還有 {count} 項沒測，確定直接完成 {key}？', { count: owed, key: item.ticketKey }) + '\n\n' + t('沒測的項目會記在驗收表上，之後查得到。資料夾要乾淨（改動都提交或捨棄了）；environment.ts 會順便還原，本機網站也會停掉。'))) {
                        act(() => api.finish(item.id, true, true));
                      }
                    }}
                  >
                    {t('直接完成（不補測）')}
                  </button>
                )}
                {/* 已完成的單發現還要改：退回作戰中，拿資料夾、切回分支、接著原本的對話 */}
                {item.status === 'committed' && (
                  <button
                    disabled={busy}
                    title={t('拿一個空的資料夾、切回這條分支，接著原本的對話')}
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      if (window.confirm(t('把 {key} 退回作戰中？', { key: item.ticketKey }) + '\n\n' + t('會拿一個空的資料夾、切回 {branch}，接著原本的對話繼續改；改完再完成一次。', { branch: item.branch }))) {
                        act(() => api.resume(item.id));
                      }
                    }}
                  >
                    {t('退回作戰中')}
                  </button>
                )}
                <button
                  className="danger"
                  disabled={busy}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open'); // 收起「更多」選單
                    setRemoving(true);
                  }}
                >
                  {t('移除')}
                </button>
              </div>
            </details>
          )}
        </div>
        </div>
        <div className="chat-head-sub">
          {/* 專案、資料夾、分支、目前在做什麼那一行拿掉了（你不需要）；只有卡住、失敗時把原因寫出來，不然不知道要怎麼處理 */}
          {['blocked', 'failed'].includes(item.status) && item.activity && <div className="warn small head-meta">{item.activity}</div>}
          {item.threadId && <Stages item={item} delivering={!!delivery?.delivering} />}
        </div>
      </div>
      {/* 基底分支有新提交：只提醒，你按「同步」才 rebase */}
      {!!item.baseBehind && !offBranch && (
        <div className="base-behind small">
          <span>{t('{base} 有 {count} 個新提交', { base: item.baseBranch, count: item.baseBehind })}</span>
          <button className="link small" disabled={busy || running} title={running ? t('AI 執行中，等它停下來再同步') : t('把這張單的分支 rebase 到最新的 {base}（沒提交的修改會先收起來、做完放回；有衝突交給 AI 解）', { base: item.baseBranch })} onClick={() => act(() => api.syncBase(item.id))}>
            {t('同步')}
          </button>
        </div>
      )}
      {offBranch && git && (
        <div className="error branch-off">
          {t('資料夾 {folder} 現在在 {current}，不是這張單的分支 {branch}。', { folder: String(item.folder), current: git.branch || t('（不在任何分支）'), branch: item.branch })}
          {git.retired
            ? t('這是你自己也在用的資料夾，FlowPilot 不切它：按上方的「搬到 FlowPilot 的資料夾繼續」。')
            : t('切回來之前不能跟 AI 說話、測試或完成：按上方的「切回」。')}
        </div>
      )}

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const box = e.currentTarget;
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        }}
      >
        {loading && <p className="muted small">{t('讀取對話紀錄中…')}</p>}
        {!item.threadId && <p className="muted">{item.activity || t('還沒開始跟 AI 對話。')}</p>}
        {/* 多語系進度像一則訊息：排在開始的時間點，之後的訊息排在它下面，跟著一起捲走 */}
        {item.i18n && i18nAt < 0 && <I18nBar id={item.id} progress={item.i18n} />}
        {entries.map((entry, index) => (
          <Fragment key={entry.id}>
            <Entry entry={entry} />
            {item.i18n && index === i18nAt && <I18nBar id={item.id} progress={item.i18n} />}
          </Fragment>
        ))}
        {running && <div className="muted small typing">{t('AI 工作中…')}</div>}

        {item.pending?.kind === 'approval' && (
          <div className="pending">
            <div>
              {t('AI 要執行')}<strong>{item.pending.reason}</strong>{t('的指令：')}
            </div>
            <code className="command">{item.pending.command}</code>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => act(() => api.approve(item.id, true))}>{t('同意')}</button>
              <button disabled={busy} onClick={() => act(() => api.approve(item.id, false))}>{t('拒絕')}</button>
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
                {q.options.length > 0 && <div className="muted">{t('選項：{options}', { options: q.options.join(t('／')) })}</div>}
              </div>
            ))}
            <div className="muted small">{t('在下面的輸入框回答。')}</div>
          </div>
        )}
      </div>

      {notice && <div className="notice-ok">{notice}</div>}
      {reportProgress && <div className="notice-ok"><span className="spinner" /> {t('分析報告：{step}（大約一兩分鐘，好了會通知你）', { step: reportProgress })}</div>}
      {error && <div className="error">{error}</div>}

      {canSend && (
        <div className={`composer ${awaitingYou ? 'attention' : ''} ${attach.dragging ? 'dragging' : ''}`} {...attach.bind}>
          {attach.view}
          {lookMode && (
            <div className="look-chip">
              <span className="fp-tag">FlowPilot</span> {t('看我的模式開著：你說的話 AI 都會先看你在 Chrome 選的畫面，要它測它就會親自操作（寫入資料前會先問你）')}
              <button className="link" title={t('關掉看我的模式')} onClick={() => setLookMode(false)}>×</button>
            </div>
          )}
          <textarea
            ref={input}
            rows={3}
            value={text}
            placeholder={
              running ? t('補充指示（會插進正在進行的這一輪，Enter 送出，Shift＋Enter 換行）。可以附圖。')
              : awaitingYou ? t('AI 在等你回答…（Enter 送出，Shift＋Enter 換行；可以附圖：按「截圖」、拖曳進來或直接貼上）')
              : t('跟 AI 說…（Enter 送出，Shift＋Enter 換行；可以附圖：按「截圖」、拖曳進來或直接貼上）')
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter 送出、Shift＋Enter 換行；中文輸入法選字時按的 Enter 不算
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="row composer-actions">
            {attach.pickButton}
            <button className="primary" disabled={busy || (!text.trim() && attach.images.length === 0)} onClick={send}>
              {t('送出')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
