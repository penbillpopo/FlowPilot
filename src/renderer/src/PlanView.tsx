// 第二階段畫面：計畫表。AI 先判斷每張單的專案與商戶，你可以改；檢查分支是否已建立後確認。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JiraTicket, PlanBranch, PlanEntry, PlanOptions, Review, RunSummary, SkillInfo, TicketPlan } from '../../shared/types';
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
  if (!plan.skill) return '還沒選技能';
  if (!/^feat\([A-Z]+-\d+\) \S/.test(plan.prTitle)) return '標題格式要是 feat(單號) 英文描述';
  return null;
}

/** 你自己寫的技能放在 ~/.codex/skills/ 底下，排在前面 */
const isOwnSkill = (skill: SkillInfo) => /\/\.codex\/skills\/[^/]+\/SKILL\.md$/.test(skill.path);

const RESOURCE_LABEL = { figma: 'Figma', document: '文件', jira: 'Jira', attachment: '附件', link: '網頁' } as const;

const ROLE_LABEL: Record<PlanBranch['role'], string> = { single: '開發', source: '開發（來源）', target: '移植目標' };

interface Props {
  run: RunSummary;
  tickets: JiraTicket[];
  onBack(): void;
  /** 計畫確認並開始執行後 */
  onConfirmed(): void;
}

export function PlanView({ run, tickets, onBack, onConfirmed }: Props) {
  const [options, setOptions] = useState<PlanOptions | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [plans, setPlans] = useState<Record<string, TicketPlan>>({});
  /** 審閱結果（判斷＋問題清單＋討論） */
  const [judgements, setJudgements] = useState<Record<string, Review>>({});
  const [judgeErrors, setJudgeErrors] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<PlanBranch[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fetchedOnce = useRef(false);
  /** 開發模式下 React 會把初始化跑兩次，用這個避免每張單判斷兩次 */
  const started = useRef(false);
  /** 看板上還沒結束的工作（同一條分支不會重複建立） */
  const [active, setActive] = useState<{ branch: string; status: string }[]>([]);

  async function judge(ticket: JiraTicket, defaultSkill: string, force = false) {
    setJudgeErrors(({ [ticket.key]: _, ...rest }) => rest);
    if (force) {
      setPlans(({ [ticket.key]: _, ...rest }) => rest);
      setJudgements(({ [ticket.key]: _, ...rest }) => rest);
    }
    try {
      const j = await api.reviewTicket(ticket, force);
      setJudgements((prev) => ({ ...prev, [ticket.key]: j }));
      setPlans((prev) => ({
        ...prev,
        [ticket.key]: { ticket, entries: j.entries, skill: defaultSkill, prTitle: j.prTitle, reason: j.reason, summary: j.summary, resources: j.resources },
      }));
    } catch (e) {
      setJudgeErrors((prev) => ({ ...prev, [ticket.key]: errorText(e) }));
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.planOptions().then((o) => {
      setOptions(o);
      tickets.forEach((t) => judge(t, o.defaultSkill));
    });
    api.listSkills().then(setSkills).catch(() => setSkills([]));
    api
      .board()
      .then((b) => setActive(b.items.filter((i) => !['failed', 'stopped', 'removed'].includes(i.status)).map((i) => ({ branch: i.branch, status: i.status }))))
      .catch(() => {});
  }, []);

  const allJudged = tickets.every((t) => plans[t.key]);
  const readyPlans = useMemo(() => (options ? Object.values(plans).filter((p) => !problemOf(p, options)) : []), [plans, options]);

  // AI 都判斷完、或你改了內容之後，重新檢查分支（第一次會先抓遠端）
  useEffect(() => {
    if (!allJudged || !options) return;
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
  }, [allJudged, readyPlans]);

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
    setPlans((prev) => ({ ...prev, [key]: change(prev[key]) }));
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
  const toRun = tickets.filter((t) => plans[t.key]);
  const unchosen = toRun.filter((t) =>
    folderChoices(t.key).some(({ branch, local }) => {
      const folder = plans[t.key].entries.find((e) => e.project === branch.project)?.folder;
      return !folder || !local.includes(folder);
    }),
  );
  const problems = options ? toRun.map((t) => problemOf(plans[t.key], options)).filter(Boolean) : [];
  const canConfirm = allJudged && !!branches && !checking && !checkError && problems.length === 0 && unchosen.length === 0 && toRun.length > 0 && !confirming;

  async function confirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await api.confirmPlan(run.id, toRun.map((t) => plans[t.key]), judgements);
      onConfirmed();
    } catch (e) {
      setConfirmError(errorText(e));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <main>
      <header>
        <div>
          <h1>計畫表</h1>
          <p className="muted">AI 先判斷每張單要做在哪個專案與商戶，有錯直接改。確認後會建立分支、分配資料夾，交給 Codex 開始開發。</p>
        </div>
        <div className="actions">
          <button onClick={onBack}>返回</button>
          <button onClick={recheck} disabled={checking || !allJudged}>{checking ? '檢查中…' : '重新檢查分支'}</button>
        </div>
      </header>

      {checkError && <div className="error">檢查分支失敗：{checkError}</div>}

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
                    <button className="link" onClick={() => window.confirm('重新審閱這張單？目前的問題、你的回答和討論都會被新的結果取代。') && judge(ticket, options!.defaultSkill, true)}>重新審閱</button>
                  </span>
                )}
              </div>

              {!plan && !error && <p className="muted">AI 審閱中…（讀單、判斷專案；一般或複雜的單會大略看程式碼，約 1 分鐘）</p>}
              {error && (
                <div className="error">
                  AI 審閱失敗：{error} <button onClick={() => judge(ticket, options!.defaultSkill)}>重試</button>
                </div>
              )}

              {plan && options && (
                <>
                  <div className="plan-block">
                    <div className="plan-block-title">要做什麼</div>
                    {plan.summary?.length ? (
                      <ul className="summary">{plan.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
                    ) : (
                      <p className="muted small">AI 沒有整理出重點，請點單號看原文。</p>
                    )}
                  </div>

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
                    <label>
                      技能
                      <select value={plan.skill} onChange={(e) => update(ticket.key, (p) => ({ ...p, skill: e.target.value }))}>
                        {!skills.some((s) => s.name === plan.skill) && <option>{plan.skill}</option>}
                        <optgroup label="你的技能">
                          {skills.filter(isOwnSkill).map((s) => <option key={s.name} title={s.description}>{s.name}</option>)}
                        </optgroup>
                        <optgroup label="其他技能">
                          {skills.filter((s) => !isOwnSkill(s)).map((s) => <option key={s.name} title={s.description}>{s.name}</option>)}
                        </optgroup>
                      </select>
                    </label>
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
                </>
              )}
            </section>
          );
        })}
      </div>

      {confirmError && <div className="error">{confirmError}</div>}

      <footer>
        <span className="muted">
          {!allJudged ? 'AI 審閱中…' : checking ? '檢查分支中（會先抓遠端）…' : `${toRun.length} 張要執行${unchosen.length ? `，${unchosen.length} 張還沒選資料夾` : ''}`}
        </span>
        <button className="primary" disabled={!canConfirm} onClick={confirm}>
          {confirming ? '確認中…' : '確認計畫，開始開發'}
        </button>
      </footer>
    </main>
  );
}
