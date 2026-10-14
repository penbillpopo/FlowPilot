// 計畫表裡的審閱：AI 找出的問題，你可以回答、照建議、標成不是問題；也可以跟 AI 討論這張單。
import { useState } from 'react';
import type { Review, ReviewIssue } from '../../shared/types';
import { useImageAttach } from './ImageAttach';
import { Markdown } from './Markdown';

const api = window.flowpilot;

function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

/** 還沒處理的問題整理成給 PM 的留言：重要的在前，附原文與建議的做法 */
export function pmDraft(review: Review): string {
  const open = review.issues.filter((i) => i.status === 'open').sort((a, b) => (a.importance === b.importance ? 0 : a.importance === '重要' ? -1 : 1));
  return [
    `${review.ticketKey} 開發前有幾個地方想跟你確認：`,
    '',
    ...open.flatMap((i, n) => [
      `${n + 1}. ${i.importance === '重要' ? '【重要】' : ''}${i.title}`,
      ...(i.quote && i.quote !== '單上沒有提到' ? [`   單上寫：「${i.quote}」`] : []),
      ...(i.detail ? [`   ${i.detail}`] : []),
      ...(i.suggestion ? [`   我目前打算：${i.suggestion}，如果不對再麻煩告訴我。`] : []),
      '',
    ]),
    '謝謝！',
  ].join('\n');
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
          {issue.status === 'answered' && <>{issue.byDiscussion ? '討論後釐清' : '你的回答'}：{issue.answer}</>}
          {issue.status === 'dismissed' && issue.answer && <>{issue.byDiscussion ? '討論後判斷不是問題' : '不是問題'}：{issue.answer}</>}
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
  const attach = useImageAttach();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = review.issues.filter((i) => i.status === 'open').length;

  async function send() {
    if (!text.trim() && !attach.images.length) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.discussReview(review.ticketKey, text, attach.images));
      setText('');
      attach.clear();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 還沒處理、而且 AI 有給建議的問題，可以一次全部照建議
  const openWithSuggestion = review.issues.filter((i) => i.status === 'open' && i.suggestion);
  async function assumeAll() {
    setBusy(true);
    try {
      let latest = review;
      for (const issue of openWithSuggestion) latest = await api.updateIssue(review.ticketKey, issue.id, { status: 'assumed' });
      onChange(latest);
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
        {review.issues.some((i) => i.status === 'open') && (
          <button className="link" onClick={() => setDraft(pmDraft(review))} title="把還沒處理的問題整理成一段留言，複製貼到 Jira 問 PM">
            產生給 PM 的留言
          </button>
        )}
        {openWithSuggestion.length > 1 && (
          <button className="link" disabled={busy} onClick={assumeAll}>
            全部照 AI 建議（{openWithSuggestion.length}）
          </button>
        )}
      </div>
      {draft !== null && (
        <div className="pm-draft">
          <div className="muted small">給 PM 的留言（可以先改，再複製貼到 Jira；FlowPilot 不會自己發到 Jira）</div>
          <textarea rows={Math.min(14, draft.split('\n').length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => navigator.clipboard.writeText(draft).then(() => setCopied(true))}>{copied ? '已複製' : '複製'}</button>
            <button onClick={() => (setDraft(null), setCopied(false))}>關閉</button>
          </div>
        </div>
      )}
      {review.issues.length === 0 && <p className="muted small">AI 沒有發現明顯的問題。</p>}
      {/* 還沒處理的排前面，處理過的（含討論後釐清、不是問題的）收到下面 */}
      {[...review.issues].sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open')).map((issue) => (
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
      {attach.view}
      <div className={`discuss-box ${attach.dragging ? 'dragging' : ''}`} {...attach.bind}>
        <textarea
          rows={2}
          value={text}
          placeholder="跟 AI 討論這張單：追問、補充背景，或告訴它 PM 的回覆（Enter 送出，Shift＋Enter 換行）。可以附圖：按「附圖」、拖曳進來或直接貼上。AI 會一併更新上面的問題。"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter 送出、Shift＋Enter 換行；中文輸入法選字時按的 Enter 不算
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {attach.pickButton}
        <button className="primary" disabled={busy || (!text.trim() && !attach.images.length)} onClick={send}>{busy ? 'AI 思考中…' : '送出'}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
