// 第二階段畫面：計畫表。AI 先判斷每張單的專案與商戶，你可以改；檢查分支是否已建立後確認。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JiraTicket, Judgement, PlanBranch, PlanEntry, PlanOptions, RunSummary, SkillInfo, TicketPlan } from '../../shared/types';

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
  const [judgements, setJudgements] = useState<Record<string, Judgement>>({});
  const [judgeErrors, setJudgeErrors] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<PlanBranch[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fetchedOnce = useRef(false);

  async function judge(ticket: JiraTicket, defaultSkill: string) {
    setJudgeErrors(({ [ticket.key]: _, ...rest }) => rest);
    try {
      const j = await api.judgeTicket(ticket);
      setJudgements((prev) => ({ ...prev, [ticket.key]: j }));
      setPlans((prev) => ({ ...prev, [ticket.key]: { ticket, entries: j.entries, skill: defaultSkill, prTitle: j.prTitle, reason: j.reason } }));
    } catch (e) {
      setJudgeErrors((prev) => ({ ...prev, [ticket.key]: errorText(e) }));
    }
  }

  useEffect(() => {
    api.planOptions().then((o) => {
      setOptions(o);
      tickets.forEach((t) => judge(t, o.defaultSkill));
    });
    api.listSkills().then(setSkills).catch(() => setSkills([]));
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
  const isBlocked = (key: string) => branchesOf(key).some((b) => b.existsIn.length > 0);
  const toRun = tickets.filter((t) => plans[t.key] && !isBlocked(t.key));
  const skipped = tickets.filter((t) => isBlocked(t.key));
  const problems = options ? toRun.map((t) => problemOf(plans[t.key], options)).filter(Boolean) : [];
  const canConfirm = allJudged && !!branches && !checking && !checkError && problems.length === 0 && toRun.length > 0 && !confirming;

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
          const blocked = isBlocked(ticket.key);
          const problem = plan && options ? problemOf(plan, options) : null;
          return (
            <section key={ticket.key} className={`plan ${blocked ? 'blocked' : ''}`}>
              <div className="plan-head">
                <a href={ticket.url} onClick={(e) => { e.preventDefault(); api.openExternal(ticket.url); }}>{ticket.key}</a>
                <span className="plan-title">{ticket.summary}</span>
                {ticket.parent && (
                  <span className="muted">
                    主單 <a href={ticket.parent.url} onClick={(e) => { e.preventDefault(); api.openExternal(ticket.parent!.url); }}>{ticket.parent.key}</a>
                  </span>
                )}
              </div>

              {!plan && !error && <p className="muted">AI 判斷中…（讀取單的內容，約 10 秒）</p>}
              {error && (
                <div className="error">
                  AI 判斷失敗：{error} <button onClick={() => judge(ticket, options!.defaultSkill)}>重試</button>
                </div>
              )}

              {plan && options && (
                <>
                  {plan.reason && <p className="reason">AI：{plan.reason}</p>}

                  {plan.entries.map((entry, index) => {
                    const project = options.projects.find((p) => p.name === entry.project);
                    return (
                      <div className="entry" key={index}>
                        <label>
                          專案
                          <select value={entry.project} onChange={(e) => updateEntry(ticket.key, index, { project: e.target.value })}>
                            {options.projects.map((p) => <option key={p.name}>{p.name}</option>)}
                          </select>
                        </label>
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
                        {entry.reason && <p className="reason small">{entry.reason}</p>}
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
                          <span className={`badge ${b.existsIn.length ? 'exists' : b.role === 'target' ? 'later' : 'new'}`}>
                            {b.existsIn.length
                              ? `已建立（${b.existsIn.join('、')}）`
                              : b.role === 'target'
                                ? '移植目標：之後由 platform-web-copy 建立'
                                : `${ROLE_LABEL[b.role]}：將建立`}
                          </span>
                        </li>
                      ))}
                      {!branches && <li className="muted">檢查分支中…</li>}
                    </ul>
                  )}

                  {blocked && <p className="warn">此分支已建立，這張單後續流程都不會執行。</p>}
                </>
              )}
            </section>
          );
        })}
      </div>

      {confirmError && <div className="error">{confirmError}</div>}

      <footer>
        <span className="muted">
          {!allJudged ? 'AI 判斷中…' : checking ? '檢查分支中（會先抓遠端）…' : `${toRun.length} 張要執行${skipped.length ? `，${skipped.length} 張跳過` : ''}`}
        </span>
        <button className="primary" disabled={!canConfirm} onClick={confirm}>
          {confirming ? '確認中…' : '確認計畫，開始開發'}
        </button>
      </footer>
    </main>
  );
}
