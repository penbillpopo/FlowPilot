// 計畫表裡的審閱：AI 找出的問題，你可以回答、照建議、標成不是問題；也可以跟 AI 討論這張單。
import { useState } from 'react';
import type { Review, ReviewIssue } from '../../shared/types';
import { Markdown } from './Markdown';

const api = window.flowpilot;

function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

const STATUS_TEXT: Record<ReviewIssue['status'], string> = { open: '還沒處理', answered: '已回答', assumed: '照建議做', dismissed: '不是問題' };

function IssueCard({ issue, ticketKey, onChange }: { issue: ReviewIssue; ticketKey: string; onChange(review: Review): void }) {
  const [answer, setAnswer] = useState(issue.answer ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(status: ReviewIssue['status'], text?: string) {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.updateIssue(ticketKey, issue.id, { status, answer: text }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const done = issue.status !== 'open';
  return (
    <div className={`issue ${issue.importance === '重要' ? 'important' : ''} ${done ? 'done' : ''}`}>
      <div className="issue-head">
        <span className={`issue-tag ${issue.importance === '重要' ? 'important' : ''}`}>{issue.importance}</span>
        <span className="issue-type">{issue.type}</span>
        <strong>{issue.title}</strong>
        {done && <span className="issue-status">{STATUS_TEXT[issue.status]}</span>}
      </div>
      {!done && (
        <>
          {issue.detail && <div className="issue-detail">{issue.detail}</div>}
          {issue.quote && <div className="issue-quote">原文（{issue.from}）：「{issue.quote}」</div>}
          {issue.suggestion && <div className="issue-suggestion">AI 建議先：{issue.suggestion}</div>}
          <div className="issue-actions">
            <input value={answer} placeholder="你知道答案就寫在這裡…" onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && set('answered', answer)} />
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => set('answered', answer)}>回答</button>
            <button disabled={busy || !issue.suggestion} onClick={() => set('assumed')}>照 AI 建議</button>
            <button disabled={busy} onClick={() => set('dismissed')}>不是問題</button>
          </div>
        </>
      )}
      {done && (
        <div className="issue-detail">
          {issue.status === 'answered' && <>你的回答：{issue.answer}</>}
          {issue.status === 'assumed' && <>照 AI 建議：{issue.suggestion}</>}
          <button className="link" disabled={busy} onClick={() => set('open')}>重新打開</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function ReviewIssues({ review, onChange }: { review: Review; onChange(review: Review): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = review.issues.filter((i) => i.status === 'open').length;

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.discussReview(review.ticketKey, text));
      setText('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plan-block">
      <div className="plan-block-title">
        問題（{review.issues.length}{open ? `，${open} 個還沒處理` : ''}）
        <span className="muted small review-meta">
          {review.level}單 · {review.codeChecked ? '有大略看程式碼' : '只看單的內容'} · 問題不會擋住開發，沒處理的會告訴開發的 AI 先跳過或照建議做
        </span>
      </div>
      {review.issues.length === 0 && <p className="muted small">AI 沒有發現明顯的問題。</p>}
      {review.issues.map((issue) => (
        <IssueCard key={`${issue.id}-${issue.status}`} issue={issue} ticketKey={review.ticketKey} onChange={onChange} />
      ))}

      {review.discussion.length > 0 && (
        <div className="discussion">
          {review.discussion.map((m, i) => (
            <div key={i} className={`msg ${m.role === 'you' ? 'user' : 'assistant'}`}>
              <Markdown text={m.text} />
            </div>
          ))}
        </div>
      )}
      <div className="discuss-box">
        <textarea
          rows={2}
          value={text}
          placeholder="跟 AI 討論這張單：追問、補充背景，或告訴它 PM 的回覆（⌘＋Enter 送出）。AI 會一併更新上面的問題。"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'AI 思考中…' : '送出'}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
