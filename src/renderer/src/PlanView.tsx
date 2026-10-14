// 第二階段畫面：計畫表。AI 先判斷每張單的專案與商戶，你可以改；檢查分支是否已建立後確認。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JiraTicket, PlanBranch, PlanDraft, PlanEntry, PlanOptions, Review, ReviewChecks, SupplementItem, TicketPlan } from '../../shared/types';
import { ReviewIssues } from './ReviewIssues';

const api = window.flowpilot;

function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

/** 多商戶時的來源商戶（跟主程序同一套規則：1 > 5 > 8 > 其他數字小的） */
function pickSource(merchants: number[]): number | null {
  if (!merchants.length) return null;
  return [1, 5, 8].find((m) => merchants.includes(m)) ?? [...merchants].sort((a, b) => a - b)[0];
}

function problemOf(plan: TicketPlan, options: PlanOptions): string | null {
  if (!plan.entries.length) return '還沒選專案';
  for (const entry of plan.entries) {
    const project = options.projects.find((p) => p.name === entry.project);
    if (project?.merchants && !entry.merchants.length) return `${entry.project} 還沒選商戶`;
  }
  if (new Set(plan.entries.map((e) => e.project)).size !== plan.entries.length) return '同一個專案出現兩次';
  if (!/^feat\([A-Z]+-\d+(, ?[A-Z]+-\d+)*\) \S/.test(plan.prTitle)) return '標題格式要是 feat(單號) 英文描述';
  return null;
}

const RESOURCE_LABEL = { figma: 'Figma', document: '文件', jira: 'Jira', attachment: '附件', link: '網頁' } as const;

const ROLE_LABEL: Record<PlanBranch['role'], string> = { single: '開發', source: '開發（來源）', target: '移植目標' };

const CHECK_LABEL: Record<keyof ReviewChecks, string> = {
  figma: '審閱時對照 Figma 設計稿',
  codeReview: '開發完 AI 先自我審查程式碼',
  designCompare: '測試時截圖跟設計稿比對',
};

/** 檢查計畫：AI 判斷這張單需要哪些額外檢查，你可以勾掉或加上 */
function CheckPlan({ review, onChange }: { review: Review; onChange(review: Review): void }) {
  const [error, setError] = useState<string | null>(null);
  if (!review.checks) return null; // 舊的審閱結果沒有
  const checks = review.checks;
  async function toggle(key: keyof ReviewChecks) {
    setError(null);
    try {
      onChange(await api.setReviewChecks(review.ticketKey, { ...checks, [key]: { ...checks[key], need: !checks[key].need } }));
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="plan-block">
      <div className="plan-block-title">檢查計畫 <span className="muted small">AI 依這張單判斷要做哪些額外檢查，你可以改</span></div>
      <ul className="check-plan">
        {(Object.keys(CHECK_LABEL) as (keyof ReviewChecks)[]).map((key) => (
          <li key={key}>
            <label>
              <input type="checkbox" checked={checks[key].need} onChange={() => toggle(key)} />
              {CHECK_LABEL[key]}
              {key === 'figma' && review.figmaChecked && <span className="mark">已對照</span>}
            </label>
            {checks[key].reason && <span className="muted small">{checks[key].reason}</span>}
          </li>
        ))}
      </ul>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/**
 * 補充資料：需求不一定在單上（Confluence 問題表、截圖、口頭說明）。
 * Confluence 網址會讀內容（問題表只取這張單的那幾列和截圖），文字、截圖直接給 AI；改完要重新審閱才會套用。
 */
function Supplements({ draft, reviewing, applied, onChange, onReview }: { draft: PlanDraft; reviewing: boolean; applied: boolean; onChange(drafts: PlanDraft[]): void; onReview(): void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const extras = draft.extras;

  async function save(next: SupplementItem[]) {
    setError(null);
    try {
      onChange(await api.planSetExtras(draft.ticket.key, next));
      setDirty(true);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function add() {
    const text = input.trim();
    if (!text) return;
    // 一行一個網址就當網址，其他當文字說明
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const items: SupplementItem[] = lines.every((l) => /^https?:\/\/\S+$/.test(l)) ? lines.map((value) => ({ kind: 'url', value })) : [{ kind: 'text', value: text }];
    setInput('');
    save([...extras, ...items]);
  }

  async function paste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const paths = await Promise.all(files.map(async (f) => api.saveImage(await f.arrayBuffer(), f.type.split('/')[1] ?? 'png')));
    save([...extras, ...paths.map((value) => ({ kind: 'image' as const, value }))]);
  }

  const imageNo = (i: number) => extras.slice(0, i + 1).filter((x) => x.kind === 'image').length;
  return (
    <div className="plan-block supplements">
      <div className="plan-block-title">
        補充資料（{extras.length}）
        <span className="muted small">需求不在單上時用：Confluence 網址會讀內容（問題表只取這張單的那一列和截圖）、文字說明、直接貼上截圖</span>
      </div>
      {extras.length > 0 && (
        <ul className="supplement-list">
          {extras.map((x, i) => (
            <li key={i}>
              <span className="mark">{x.kind === 'url' ? '網址' : x.kind === 'text' ? '說明' : '截圖'}</span>
              <span className="supplement-value" title={x.value}>{x.kind === 'image' ? `截圖 ${imageNo(i)}` : x.value}</span>
              <button className="link small danger" onClick={() => save(extras.filter((_, j) => j !== i))}>拿掉</button>
            </li>
          ))}
        </ul>
      )}
      <div className="supplement-input">
        <textarea
          rows={2}
          value={input}
          placeholder="貼 Confluence 網址（一行一個）、打一段說明，或直接貼上截圖"
          onChange={(e) => setInput(e.target.value)}
          onPaste={paste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        />
        <button disabled={!input.trim()} onClick={add}>加入</button>
      </div>
      {(dirty || !applied) && extras.length > 0 && !reviewing && (
        <p className="warn small">
          補充資料要重新審閱才會套用（目前的問題和討論會被新的結果取代）。
          <button className="link small" onClick={() => { setDirty(false); onReview(); }}>重新審閱</button>
        </p>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/** 審閱整理出來、會交給開發 AI 的需求分析（要做什麼之外的三段） */
function BriefBlocks({ review }: { review: Review }) {
  const blocks: [string, string[] | undefined, string][] = [
    ['預期結果（逐條，測試時一條一條對照）', review.acceptance, '單上沒有寫預期結果。'],
    ['牽涉頁面', review.pages, '審閱時沒有確定，開發時 AI 會看程式碼找出來。'],
    ['後端 API', review.apis, '單上沒有寫 API 規格。'],
    ['預計執行內容', review.steps, 'AI 會在開發時自己規劃。'],
  ];
  // 舊的審閱結果沒有這些欄位，就不顯示
  if (!review.pages && !review.apis && !review.steps) return null;
  return (
    <>
      {blocks.map(([title, items, empty]) => (
        <div className="plan-block" key={title}>
          <div className="plan-block-title">{title}</div>
          {items?.length ? <ul className="summary">{items.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="muted small">{empty}</p>}
        </div>
      ))}
    </>
  );
}

interface Props {
  /** 計畫表裡的單（加進來就留著，返回也不會清掉） */
  drafts: PlanDraft[];
  /** 計畫表裡的單變了（確認開工、移除） */
  onChange(drafts: PlanDraft[]): void;
  onBack(): void;
  /** 計畫表裡的單都確認開工了 */
  onConfirmed(): void;
}

export function PlanView({ drafts, onChange, onBack, onConfirmed }: Props) {
  const tickets = drafts.map((d) => d.ticket);
  const [notice, setNotice] = useState<string | null>(null);
  const [options, setOptions] = useState<PlanOptions | null>(null);
  const [plans, setPlans] = useState<Record<string, TicketPlan>>({});
  /** 審閱結果（判斷＋問題清單＋討論） */
  const [judgements, setJudgements] = useState<Record<string, Review>>({});
  const [judgeErrors, setJudgeErrors] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<PlanBranch[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const fetchedOnce = useRef(false);
  /** 已經開始審閱的單（開發模式下 React 會把初始化跑兩次，避免每張單判斷兩次） */
  const started = useRef(new Set<string>());
  /** 看板上還沒結束的工作（同一條分支不會重複建立） */
  const [active, setActive] = useState<{ branch: string; status: string }[]>([]);

  async function judge(ticket: JiraTicket, force = false) {
    setJudgeErrors(({ [ticket.key]: _, ...rest }) => rest);
    if (force) {
      setPlans(({ [ticket.key]: _, ...rest }) => rest);
      setJudgements(({ [ticket.key]: _, ...rest }) => rest);
    }
    try {
      const j = await api.reviewTicket(ticket, force);
      setJudgements((prev) => ({ ...prev, [ticket.key]: j }));
      const fromReview: TicketPlan = { ticket, entries: j.entries, prTitle: j.prTitle, reason: j.reason, summary: j.summary, resources: j.resources };
      // 你之前改過的計畫（專案、商戶、標題）優先；重新審閱就換成新的結果
      const saved = force ? null : drafts.find((d) => d.ticket.key === ticket.key)?.plan;
      const plan = saved ? { ...fromReview, entries: saved.entries, prTitle: saved.prTitle } : fromReview;
      setPlans((prev) => ({ ...prev, [ticket.key]: plan }));
      if (force) api.planSaveDraft(ticket.key, plan).catch(() => {});
    } catch (e) {
      setJudgeErrors((prev) => ({ ...prev, [ticket.key]: errorText(e) }));
    }
  }

  useEffect(() => {
    api.planOptions().then(setOptions);
    api
      .board()
      .then((b) => setActive(b.items.filter((i) => !['failed', 'stopped', 'removed'].includes(i.status)).map((i) => ({ branch: i.branch, status: i.status }))))
      .catch(() => {});
  }, []);

  // 計畫表裡的每張單都去拿審閱結果（背景已經在審的會等同一個結果，審好的直接拿存檔）
  useEffect(() => {
    for (const t of tickets) {
      if (started.current.has(t.key)) continue;
      started.current.add(t.key);
      judge(t);
    }
  }, [drafts]);

  const allJudged = tickets.every((t) => plans[t.key]);
  const readyPlans = useMemo(() => (options ? Object.values(plans).filter((p) => drafts.some((d) => d.ticket.key === p.ticket.key) && !problemOf(p, options)) : []), [plans, options, drafts]);

  // AI 都判斷完、或你改了內容之後，重新檢查分支（第一次會先抓遠端）
  useEffect(() => {
    if (!options || !readyPlans.length) return;
    const timer = setTimeout(async () => {
      setChecking(true);
      setCheckError(null);
      try {
        setBranches(await api.checkBranches(readyPlans, !fetchedOnce.current));
        fetchedOnce.current = true;
      } catch (e) {
        setCheckError(errorText(e));
      } finally {
        setChecking(false);
      }
    }, fetchedOnce.current ? 400 : 0);
    return () => clearTimeout(timer);
  }, [readyPlans]);

  async function recheck() {
    fetchedOnce.current = false;
    setChecking(true);
    setCheckError(null);
    try {
      setBranches(await api.checkBranches(readyPlans, true));
      fetchedOnce.current = true;
    } catch (e) {
      setCheckError(errorText(e));
    } finally {
      setChecking(false);
    }
  }

  function update(key: string, change: (plan: TicketPlan) => TicketPlan) {
    setPlans((prev) => {
      const next = change(prev[key]);
      api.planSaveDraft(key, next).catch(() => {}); // 存起來，返回再進來還在
      return { ...prev, [key]: next };
    });
  }

  function updateEntry(key: string, index: number, change: Partial<PlanEntry>) {
    update(key, (plan) => ({
      ...plan,
      entries: plan.entries.map((e, i) => {
        if (i !== index) return e;
        const next = { ...e, ...change };
        // 換專案或改商戶時，重新整理商戶與來源商戶
        const project = options!.projects.find((p) => p.name === next.project);
        next.merchants = project?.merchants ? next.merchants.filter((m) => project.merchants!.includes(m)).sort((a, b) => a - b) : [];
        if (next.sourceMerchant === null || !next.merchants.includes(next.sourceMerchant)) next.sourceMerchant = pickSource(next.merchants);
        return next;
      }),
    }));
  }

  const branchesOf = (key: string) => (branches ?? []).filter((b) => b.ticketKey === key);
  /** 分支已經存在於好幾個資料夾、還沒選要用哪一個的專案 */
  const folderChoices = (key: string) =>
    branchesOf(key)
      .filter((b) => b.role !== 'target')
      .map((b) => ({ branch: b, local: b.existsIn.filter((w) => w !== '遠端') }))
      .filter(({ local }) => local.length > 1);
  const continuing = (key: string) => branchesOf(key).some((b) => b.role !== 'target' && b.existsIn.length > 0);
  const unchosenFolder = (key: string) =>
    folderChoices(key).some(({ branch, local }) => {
      const folder = plans[key].entries.find((e) => e.project === branch.project)?.folder;
      return !folder || !local.includes(folder);
    });
  /** 這張可以確認開工了嗎；不行的話回傳原因 */
  const blockerOf = (key: string): string | null => {
    if (!plans[key] || !judgements[key]) return 'AI 審閱中';
    if (!options) return '讀取中';
    const problem = problemOf(plans[key], options);
    if (problem) return problem;
    if (checking || !branches) return '檢查分支中';
    if (checkError) return '檢查分支失敗';
    if (!branches.some((b) => b.ticketKey === key)) return '檢查分支中';
    if (unchosenFolder(key)) return '還沒選資料夾';
    return null;
  };
  const ready = tickets.filter((t) => !blockerOf(t.key)).map((t) => t.key);

  async function confirm(keys: string[]) {
    setConfirming(keys);
    setConfirmError(null);
    setNotice(null);
    try {
      await api.confirmPlan(keys.map((k) => plans[k]), Object.fromEntries(keys.map((k) => [k, judgements[k]])));
      const rest = drafts.filter((d) => !keys.includes(d.ticket.key));
      onChange(rest);
      if (!rest.length) return onConfirmed();
      setNotice(`${keys.join('、')} 已經交給 AI 開發，到作戰室看進度；其他的單還留在這裡`);
    } catch (e) {
      setConfirmError(errorText(e));
    } finally {
      setConfirming(null);
    }
  }

  async function discard(key: string) {
    if (!window.confirm(`從計畫表移除 ${key}？\n\nAI 的審閱、討論紀錄和你改過的內容都會刪掉，單列表上的「計畫中」也會消失，回到原本的樣子。之後要做可以再從單列表加進來（會重新審閱）。`)) return;
    try {
      const rest = await api.planDiscard([key]);
      started.current.delete(key);
      onChange(rest);
      if (!rest.length) onBack();
    } catch (e) {
      setConfirmError(errorText(e));
    }
  }

  return (
    <main>
      <header>
        <div>
          <h1>計畫表</h1>
          <p className="muted">AI 在背景審閱每張單、判斷要做在哪個專案與商戶，有錯直接改（會自動存起來，按返回也不會清掉）。審好的單可以一張一張確認開工；同一個專案同時做幾張，看它有幾個資料夾，超過的會排隊。</p>
        </div>
        <div className="actions">
          <button onClick={onBack}>返回</button>
          <button onClick={recheck} disabled={checking || !readyPlans.length}>{checking ? '檢查中…' : '重新檢查分支'}</button>
        </div>
      </header>

      {checkError && <div className="error">檢查分支失敗：{checkError}</div>}
      {notice && <div className="notice-ok plan-notice">{notice}</div>}

      <div className="plans">
        {tickets.map((ticket) => {
          const plan = plans[ticket.key];
          const error = judgeErrors[ticket.key];
          const problem = plan && options ? problemOf(plan, options) : null;
          return (
            <section key={ticket.key} className="plan">
              <div className="plan-head">
                <a href={ticket.url} onClick={(e) => { e.preventDefault(); api.openExternal(ticket.url); }}>{ticket.key}</a>
                <span className="plan-title">{ticket.summary}</span>
                {ticket.parent && (
                  <span className="muted">
                    主單 <a href={ticket.parent.url} onClick={(e) => { e.preventDefault(); api.openExternal(ticket.parent!.url); }}>{ticket.parent.key}</a>
                  </span>
                )}
                {judgements[ticket.key] && (
                  <span className="muted small">
                    審閱於 {new Date(judgements[ticket.key].reviewedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                    <button className="link" onClick={() => window.confirm('重新審閱這張單？目前的問題、你的回答和討論都會被新的結果取代。') && judge(ticket, true)}>重新審閱</button>
                  </span>
                )}
                {/* 隨時可以移除（審閱中也可以），不用捲到最下面找 */}
                <button className="link danger" title="從計畫表拿掉，審閱和討論紀錄一起刪掉，回到原本的樣子" onClick={() => discard(ticket.key)}>移除</button>
              </div>
              {!!ticket.members?.length && (
                <ul className="group-members">
                  <span className="mark group">合成 {ticket.members.length} 張</span>
                  {ticket.members.map((m) => (
                    <li key={m.key}>
                      <a href={m.url} onClick={(e) => { e.preventDefault(); api.openExternal(m.url); }}>{m.key}</a> <span className="muted small">{m.summary}</span>
                    </li>
                  ))}
                </ul>
              )}

              {!plan && !error && <p className="muted">AI 審閱中…（讀單、判斷專案；一般或複雜的單會大略看程式碼，約 1 分鐘）</p>}
              <Supplements
                draft={drafts.find((d) => d.ticket.key === ticket.key)!}
                reviewing={!plan && !error}
                applied={!!(judgements[ticket.key]?.supplements?.length || judgements[ticket.key]?.supplementImages?.length)}
                onChange={onChange}
                onReview={() => judge(ticket, true)}
              />

              {error && (
                <div className="error">
                  AI 審閱失敗：{error} <button onClick={() => judge(ticket)}>重試</button> <button className="link danger" onClick={() => discard(ticket.key)}>移除</button>
                </div>
              )}

              {plan && options && (
                <>
                  {judgements[ticket.key]?.complete === false && (
                    <div className="review-incomplete">
                      <strong>這次審閱沒有完成</strong>：{judgements[ticket.key].problem}。下面的內容可能不完整或不正確，建議
                      <button className="link" onClick={() => window.confirm('重新審閱這張單？目前的問題、你的回答和討論都會被新的結果取代。') && judge(ticket, true)}>重新審閱</button>。
                    </div>
                  )}
                  {/* 最重要的「做在哪裡」放最上面，先確認這個再看細節 */}
                  <div className="plan-project">
                  <div className="plan-block-title">專案判斷</div>
                  {plan.reason && <p className="reason">{plan.reason}</p>}

                  {plan.entries.map((entry, index) => {
                    const project = options.projects.find((p) => p.name === entry.project);
                    return (
                      <div className="entry" key={index}>
                        <label>
                          專案
                          <select value={entry.project} onChange={(e) => updateEntry(ticket.key, index, { project: e.target.value })}>
                            {options.projects.map((p) => <option key={p.name} value={p.name}>{p.name}{p.side ? `（${p.side}）` : ''}</option>)}
                          </select>
                        </label>
                        {project?.side && <span className={`side ${project.side.startsWith('前台') ? 'front' : 'back'}`}>{project.side}</span>}
                        {project?.merchants && (
                          <div className="merchants">
                            商戶
                            {project.merchants.map((m) => (
                              <label key={m} className={`chip ${entry.merchants.includes(m) ? 'on' : ''}`}>
                                <input
                                  type="checkbox"
                                  checked={entry.merchants.includes(m)}
                                  onChange={() =>
                                    updateEntry(ticket.key, index, {
                                      merchants: entry.merchants.includes(m) ? entry.merchants.filter((x) => x !== m) : [...entry.merchants, m],
                                    })
                                  }
                                />
                                m{m}
                              </label>
                            ))}
                            {entry.merchants.length > 1 && (
                              <label>
                                來源
                                <select value={entry.sourceMerchant ?? ''} onChange={(e) => updateEntry(ticket.key, index, { sourceMerchant: Number(e.target.value) })}>
                                  {entry.merchants.map((m) => <option key={m} value={m}>m{m}</option>)}
                                </select>
                              </label>
                            )}
                          </div>
                        )}
                        {plan.entries.length > 1 && (
                          <button className="link" onClick={() => update(ticket.key, (p) => ({ ...p, entries: p.entries.filter((_, i) => i !== index) }))}>移除</button>
                        )}
                        {entry.reason && <p className="reason small why">為什麼是這個專案：{entry.reason}</p>}
                      </div>
                    );
                  })}
                  {plan.entries.length < options.projects.length && (
                    <button
                      className="link"
                      onClick={() => {
                        const unused = options.projects.find((p) => !plan.entries.some((e) => e.project === p.name))!;
                        update(ticket.key, (p) => ({ ...p, entries: [...p.entries, { project: unused.name, merchants: [], sourceMerchant: null, reason: '' }] }));
                      }}
                    >
                      ＋ 加一個專案
                    </button>
                  )}

                  <div className="fields">
                    <label className="grow">
                      標題
                      <input value={plan.prTitle} onChange={(e) => update(ticket.key, (p) => ({ ...p, prTitle: e.target.value }))} />
                    </label>
                  </div>

                  {problem && <p className="warn">{problem}</p>}

                  {!problem && (
                    <ul className="branches">
                      {branchesOf(ticket.key).map((b) => (
                        <li key={b.branch}>
                          <code>{b.branch}</code>
                          <span className="muted"> ← {b.baseBranch}</span>
                          <span className={`badge ${b.existsIn.length ? 'continue' : b.role === 'target' ? 'later' : 'new'}`}>
                            {b.role === 'target'
                              ? b.existsIn.length
                                ? `移植目標：已存在（${b.existsIn.join('、')}），移植時 platform-web-copy 會問你`
                                : '移植目標：之後由 platform-web-copy 建立'
                              : b.existsIn.length
                                ? `${ROLE_LABEL[b.role]}：已存在（${b.existsIn.join('、')}），會切換過去繼續開發`
                                : `${ROLE_LABEL[b.role]}：將建立`}
                          </span>
                        </li>
                      ))}
                      {!branches && <li className="muted">檢查分支中…</li>}
                    </ul>
                  )}

                  {folderChoices(ticket.key).map(({ branch, local }) => {
                    const entryIndex = plan.entries.findIndex((e) => e.project === branch.project);
                    return (
                      <label key={branch.branch} className="folder-choice warn">
                        {branch.branch} 在 {local.join('、')} 都有，要用哪一個資料夾繼續？
                        <select
                          value={plan.entries[entryIndex]?.folder ?? ''}
                          onChange={(e) => updateEntry(ticket.key, entryIndex, { folder: e.target.value || null })}
                        >
                          <option value="">請選擇</option>
                          {local.map((f) => <option key={f}>{f}</option>)}
                        </select>
                      </label>
                    );
                  })}
                  {branchesOf(ticket.key)
                    .filter((b) => b.role !== 'target' && active.some((a) => a.branch === b.branch))
                    .map((b) => (
                      <p key={`active-${b.branch}`} className="warn">
                        {b.branch} 在執行看板上已經有進行中的工作，確認後不會重複建立，請到執行看板繼續處理。
                      </p>
                    ))}
                  {continuing(ticket.key) && (
                    <p className="reason">分支已存在：會切換過去，請 AI 先看過現有的差異再接著開發。資料夾有未提交的修改、或本機與遠端分歧時，會先問你。</p>
                  )}
                  </div>

                  {judgements[ticket.key] && <CheckPlan review={judgements[ticket.key]} onChange={(r) => setJudgements((prev) => ({ ...prev, [ticket.key]: r }))} />}

                  <div className="plan-block">
                    <div className="plan-block-title">要做什麼</div>
                    {plan.summary?.length ? (
                      <ul className="summary">{plan.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
                    ) : (
                      <p className="muted small">AI 沒有整理出重點，請點單號看原文。</p>
                    )}
                  </div>

                  {judgements[ticket.key] && <BriefBlocks review={judgements[ticket.key]} />}

                  <div className="plan-block">
                    <div className="plan-block-title">參考資料（{plan.resources?.length ?? 0}）</div>
                    {plan.resources?.length ? (
                      <ul className="resources">
                        {plan.resources.map((r) => (
                          <li key={r.url}>
                            <span className={`res-kind res-${r.kind}`}>{RESOURCE_LABEL[r.kind]}</span>
                            <a href={r.url} onClick={(e) => { e.preventDefault(); api.openExternal(r.url); }}>{r.title}</a>
                            <span className="muted small">（{r.from}）</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">單上沒有附 Figma、文件或連結。</p>
                    )}
                  </div>

                  {judgements[ticket.key] && (
                    <ReviewIssues review={judgements[ticket.key]} onChange={(r) => setJudgements((prev) => ({ ...prev, [ticket.key]: r }))} />
                  )}

                  <div className="plan-actions">
                    <button className="link danger" onClick={() => discard(ticket.key)}>移除</button>
                    {blockerOf(ticket.key) && <span className="muted small">{blockerOf(ticket.key)}</span>}
                    <button className="primary" disabled={!!blockerOf(ticket.key) || !!confirming} onClick={() => confirm([ticket.key])}>
                      {confirming?.includes(ticket.key) ? '確認中…' : `確認 ${ticket.key}，開始開發`}
                    </button>
                  </div>

                </>
              )}
            </section>
          );
        })}
      </div>

      {confirmError && <div className="error">{confirmError}</div>}

      <footer>
        <span className="muted">
          計畫表裡 {tickets.length} 張：{ready.length} 張可以開始{!allJudged ? '，其他的 AI 還在審閱' : checking ? '，檢查分支中（會先抓遠端）…' : ''}
        </span>
      </footer>
    </main>
  );
}
