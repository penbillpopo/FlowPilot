// 已完成的單：用 Azure 發 PR。名稱預設 feat(單號) 單子名稱，可以選目標分支、審核人，說明自動帶 Jira 連結和驗收表。
import { useEffect, useState } from 'react';
import type { PrOptions, WorkItem } from '../../shared/types';
import { errorText } from './ChatPanel';

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
      setReviewers(lastReviewers().filter((id) => o.reviewers.some((r) => r.id === id)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!options) return;
    const names = options.reviewers.filter((r) => reviewers.includes(r.id)).map((r) => r.name);
    const ok = window.confirm(`在 Azure 發 PR？\n\n${title}\n${options.source} → ${target}\n審核人：${names.length ? names.join('、') : '（沒有）'}`);
    if (!ok) return;
    setSending(true);
    setError(null);
    try {
      await api.pr.create(item.id, { title, description, target, reviewerIds: reviewers });
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
      <strong>已發的 PR（{item.prs.length}）</strong>
      <ul className="pr-list">
        {item.prs.map((p) => (
          <li key={p.url}>
            <div className="pr-line">
              <span>發到 <code>{p.target || '（讀取中）'}</code></span>
              {p.status && <span className={`mark pr-${p.status}`}>{PR_STATUS[p.status]}</span>}
              <button className="link small" onClick={() => api.openExternal(p.url)}>打開</button>
            </div>
            {p.title && <div className="pr-title" title={p.title}>{p.title}</div>}
            <div className="muted small">審核人：{p.reviewers ? (p.reviewers.length ? p.reviewers.join('、') : '沒有') : '（讀取中）'}</div>
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
          <button className="primary" disabled={loading} onClick={open}>{loading ? '讀取 Azure 中…' : item.prs.length ? '用 Azure 再發一個 PR' : '用 Azure 發 PR'}</button>
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
        <strong>用 Azure 發 PR</strong>
        <button className="link small" onClick={() => setOptions(null)}>取消</button>
      </div>
      {options.notPushed && <div className="error small">遠端還沒有 {options.source}，要先推送才能發 PR。</div>}
      <label className="pr-field">
        <span className="muted small">PR 名稱</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="pr-field">
        <span className="muted small">目標分支（{options.source} 要合併進去的）</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {!target && <option value="">請選擇</option>}
          {target && !options.branches.includes(target) && <option value={target}>{target}</option>}
          {options.branches.map((b) => (
            <option key={b} value={b}>{b}{b === options.target ? '（基底）' : ''}{options.existing.some((p) => p.target === b) ? '（已發過）' : ''}</option>
          ))}
        </select>
      </label>
      <div className="pr-field">
        <span className="muted small">審核人（從這個專案最近的 PR 找出來的）</span>
        {options.reviewers.length === 0 && <p className="muted small">最近的 PR 沒有審核人。</p>}
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
      <label className="pr-field">
        <span className="muted small">說明（自動帶 Jira 連結和驗收表，可以改）</span>
        <textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {sameTarget && (
        <p className="warn small">
          {options.source} → {target} 已經有開著的 PR，不能再發一個。
          <button className="link small" onClick={() => api.openExternal(sameTarget.url)}>打開那個 PR</button>
        </p>
      )}
      <button className="primary" disabled={sending || options.notPushed || !title.trim() || !target || !!sameTarget} onClick={send}>
        {sending ? '發 PR 中…' : '發 PR'}
      </button>
      {error && <div className="error small">{error}</div>}
    </div>
    </>
  );
}
