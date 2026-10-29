// 已完成的單：用 Azure 發 PR。名稱預設 feat(單號) 單子名稱，可以選目標分支、審核人，說明自動帶 Jira 連結和驗收表。
import { useEffect, useState } from 'react';
import type { PrOptions, WorkItem } from '../../shared/types';
import { errorText } from './ChatPanel';
import { t } from '../../shared/i18n';

const api = window.flowpilot;
const REVIEWERS_KEY = 'flowpilot.prReviewers';

/** 上次選的審核人（存在這台電腦的瀏覽器儲存空間，讀不到就不預選） */
function lastReviewers(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(REVIEWERS_KEY) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/** 一起發的其他商戶：目標分支換成那個商戶的（例如 master-1 → master-2）；跟主程式的規則一樣 */
function targetFor(target: string, from: number | null, to: number): string {
  if (from === null) return target;
  const m = target.match(new RegExp(`^(.*?)${from}$`));
  return m ? `${m[1]}${to}` : target;
}

// i18n-keys：顯示時才翻
const PR_STATUS = { active: '審核中', completed: '已合併', abandoned: '已放棄' } as const;

export function PrPanel({ item }: { item: WorkItem }) {
  const [options, setOptions] = useState<PrOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [description, setDescription] = useState('');
  const [reviewers, setReviewers] = useState<string[]>([]);
  /** 一起發 PR 的其他商戶 */
  const [also, setAlso] = useState<number[]>([]);
  /** 上一次發的結果（一起發好幾個商戶時，逐一列出成功或失敗） */
  const [results, setResults] = useState<{ merchant: number | null; target: string; url?: string; error?: string }[] | null>(null);

  // 打開時向 Azure 讀回發過的 PR 現在的狀態、目標分支、審核人
  useEffect(() => {
    if (item.prs.length) api.pr.refresh(item.id).catch(() => {});
  }, [item.id]);

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const o = await api.pr.options(item.id);
      setOptions(o);
      setTitle(o.title);
      // 預設目標：基底分支；基底已經發過就先空著讓你選
      setTarget(o.existing.some((p) => p.target === o.target) ? '' : o.target);
      setDescription(o.description);
      // 設定檔指定了審核人：全部勾好；沒指定就沿用上次勾的
      setReviewers(o.fixedReviewers ? o.reviewers.map((r) => r.id) : lastReviewers().filter((id) => o.reviewers.some((r) => r.id === id)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!options) return;
    const names = options.reviewers.filter((r) => reviewers.includes(r.id)).map((r) => r.email || r.name);
    const others = options.siblings.filter((x) => also.includes(x.id));
    const lines = [`${options.source} → ${target}`, ...others.map((x) => `${x.branch} → ${targetFor(target, item.merchant, x.merchant)}`)];
    const ok = window.confirm(
      t('在 Azure 發 {count} 個 PR？\n\n{title}\n{lines}\n\n審核人：{reviewers}', {
        count: lines.length,
        title,
        lines: lines.join('\n'),
        reviewers: names.length ? names.join(t('、')) : t('（沒有）'),
      }),
    );
    if (!ok) return;
    setSending(true);
    setError(null);
    try {
      const { results } = await api.pr.create(item.id, { title, description, target, reviewerIds: reviewers, alsoItemIds: others.map((x) => x.id) });
      setResults(results);
      setAlso([]);
      try {
        localStorage.setItem(REVIEWERS_KEY, JSON.stringify(reviewers));
      } catch {}
      setOptions(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  // 發過的 PR：一張單可以發好幾個（例如同一條分支發到 sit、uat、master）
  const sent = item.prs.length > 0 && (
    <div className="panel pr-panel">
      <strong>{t('已發的 PR（{count}）', { count: item.prs.length })}</strong>
      <ul className="pr-list">
        {item.prs.map((p) => (
          <li key={p.url}>
            <div className="pr-line">
              <span>{t('發到 ')}<code>{p.target || t('（讀取中）')}</code></span>
              {p.status && <span className={`mark pr-${p.status}`}>{t(PR_STATUS[p.status])}</span>}
              <button className="link small" onClick={() => api.openExternal(p.url)}>{t('打開')}</button>
            </div>
            {p.title && <div className="pr-title" title={p.title}>{p.title}</div>}
            <div className="muted small">{t('審核人：{reviewers}', { reviewers: p.reviewers ? (p.reviewers.length ? p.reviewers.join(t('、')) : t('沒有')) : t('（讀取中）') })}</div>
          </li>
        ))}
      </ul>
    </div>
  );

  if (!options) {
    return (
      <>
        {sent}
        <div className="panel pr-panel">
          {results && (results.length > 1 || results.some((r) => r.error)) && (
            <ul className="pr-results">
              {results.map((r, i) => (
                <li key={i} className={r.error && !r.url ? 'bad' : ''}>
                  {r.merchant !== null ? `m${r.merchant}` : ''} → <code>{r.target}</code>{t('：')}{r.error ?? t('已發')}
                  {r.url && <button className="link small" onClick={() => api.openExternal(r.url!)}>{t('打開')}</button>}
                </li>
              ))}
            </ul>
          )}
          <button className="primary" disabled={loading} onClick={open}>{loading ? t('讀取 Azure 中…') : item.prs.length ? t('用 Azure 再發一個 PR') : t('用 Azure 發 PR')}</button>
          {error && <div className="error small">{error}</div>}
        </div>
      </>
    );
  }

  // 同一個目標分支已經有開著的 PR：Azure 不允許重複，直接給那個 PR
  const sameTarget = options.existing.find((p) => p.target === target);

  return (
    <>
    {sent}
    <div className="panel pr-panel">
      <div className="panel-head">
        <strong>{t('用 Azure 發 PR')}</strong>
        <button className="link small" onClick={() => setOptions(null)}>{t('取消')}</button>
      </div>
      {options.notPushed && <div className="error small">{t('遠端還沒有 {source}，要先推送才能發 PR。', { source: options.source })}</div>}
      <label className="pr-field">
        <span className="muted small">{t('PR 名稱')}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="pr-field">
        <span className="muted small">{t('目標分支（{source} 要合併進去的）', { source: options.source })}</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {!target && <option value="">{t('請選擇')}</option>}
          {target && !options.branches.includes(target) && <option value={target}>{target}</option>}
          {options.branches.map((b) => (
            <option key={b} value={b}>{b}{b === options.target ? t('（基底）') : ''}{options.existing.some((p) => p.target === b) ? t('（已發過）') : ''}</option>
          ))}
        </select>
      </label>
      <div className="pr-field">
        <span className="muted small">{options.fixedReviewers ? t('審核人（設定檔指定的）') : t('審核人（從這個專案最近的 PR 找出來的）')}</span>
        {options.reviewers.length === 0 && <p className="muted small">{options.fixedReviewers ? t('設定檔指定的審核人，在這個專案最近的 PR 裡找不到（要有他審過的 PR 才查得到）。') : t('最近的 PR 沒有審核人。')}</p>}
        {options.reviewers.map((r) => (
          <label key={r.id} className="pr-reviewer">
            <input
              type="checkbox"
              checked={reviewers.includes(r.id)}
              onChange={() => setReviewers((prev) => (prev.includes(r.id) ? prev.filter((x) => x !== r.id) : [...prev, r.id]))}
            />
            {/* Azure 的顯示名稱常常就是信箱拆開（例如「mcl intellianalyze.com」），只顯示信箱 */}
            <span title={r.name}>{r.email || r.name}</span>
          </label>
        ))}
      </div>
      {options.siblings.length > 0 && (
        <div className="pr-field">
          <span className="muted small">{t('也幫其他商戶發（名稱、審核人一樣；目標分支換成各自的）')}</span>
          {options.siblings.map((x) => {
            const to = targetFor(target, item.merchant, x.merchant);
            const sent = x.prs.some((p) => p.target === to && p.status !== 'completed' && p.status !== 'abandoned');
            const why = !x.pushed ? t('還沒推送') : sent ? t('已經發過') : null;
            return (
              <label key={x.id} className={`pr-reviewer ${why ? 'disabled' : ''}`} title={why ?? undefined}>
                <input
                  type="checkbox"
                  disabled={!!why || !target}
                  checked={also.includes(x.id)}
                  onChange={() => setAlso((prev) => (prev.includes(x.id) ? prev.filter((v) => v !== x.id) : [...prev, x.id]))}
                />
                <span>{t('m{merchant}：{branch} → ', { merchant: x.merchant, branch: x.branch })}<code>{to || '—'}</code></span>
                {why && <span className="muted small">{t('（{why}）', { why })}</span>}
              </label>
            );
          })}
        </div>
      )}
      <label className="pr-field">
        <span className="muted small">{t('說明（自動帶 Jira 連結和驗收表，可以改）')}</span>
        <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {sameTarget && (
        <p className="warn small">
          {t('{source} → {target} 已經有開著的 PR，不能再發一個。', { source: options.source, target })}
          <button className="link small" onClick={() => api.openExternal(sameTarget.url)}>{t('打開那個 PR')}</button>
        </p>
      )}
      <button className="primary" disabled={sending || options.notPushed || !title.trim() || !target || !!sameTarget} onClick={send}>
        {sending ? t('發 PR 中…') : t('發 PR')}
      </button>
      {error && <div className="error small">{error}</div>}
    </div>
    </>
  );
}
