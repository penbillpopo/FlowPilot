// 計畫表裡的審閱：AI 找出的問題，你可以回答、照建議、標成不是問題；也可以跟 AI 討論這張單。
import { useState } from 'react';
import type { Review, ReviewIssue } from '../../shared/types';
import { appendPaths, useImageAttach } from './ImageAttach';
import { Markdown } from './Markdown';
import { inChinese, t, zhOnly } from '../../shared/i18n';

const api = window.flowpilot;

function errorText(e: unknown) {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

/** 還沒處理的問題整理成給 PM 的留言：要貼到 Jira 給 PM 看，固定用中文（不管介面語言） */
export function pmDraft(review: Review): string {
  return inChinese(() => buildPmDraft(review));
}

/** 重要的在前，附原文與建議的做法 */
function buildPmDraft(review: Review): string {
  const open = review.issues.filter((i) => i.status === 'open').sort((a, b) => (a.importance === b.importance ? 0 : a.importance === zhOnly('重要') ? -1 : 1));
  return [
    t('{key} 開發前有幾個地方想跟你確認：', { key: review.ticketKey }),
    '',
    ...open.flatMap((i, n) => [
      `${n + 1}. ${i.importance === zhOnly('重要') ? t('【重要】') : ''}${i.title}`,
      ...(i.quote && i.quote !== zhOnly('單上沒有提到') ? [t('   單上寫：「{quote}」', { quote: i.quote })] : []),
      ...(i.detail ? [`   ${i.detail}`] : []),
      ...(i.suggestion ? [t('   我目前打算：{suggestion}，如果不對再麻煩告訴我。', { suggestion: i.suggestion })] : []),
      '',
    ]),
    t('謝謝！'),
  ].join('\n');
}

// i18n-keys：顯示時才翻
const IMPORTANCE_TEXT: Record<string, string> = { 重要: '重要', 一般: '一般' };

// i18n-keys：顯示時才翻
const TYPE_TEXT: Record<string, string> = {
  邏輯矛盾: '邏輯矛盾',
  需求不明確: '需求不明確',
  遺漏情境: '遺漏情境',
  前後端對不上: '前後端對不上',
  跟設計稿不一致: '跟設計稿不一致',
  範圍不清: '範圍不清',
  跟現有功能衝突: '跟現有功能衝突',
};

// i18n-keys：顯示時才翻
const LEVEL_TEXT: Record<string, string> = { 小: '小單', 一般: '一般單', 複雜: '複雜單' };

// i18n-keys：顯示時才翻
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
    <div className={`issue ${issue.importance === zhOnly('重要') ? 'important' : ''} ${done ? 'done' : ''}`}>
      <div className="issue-head">
        <span className={`issue-tag ${issue.importance === zhOnly('重要') ? 'important' : ''}`}>{t(IMPORTANCE_TEXT[issue.importance] ?? issue.importance)}</span>
        <span className="issue-type">{TYPE_TEXT[issue.type] ? t(TYPE_TEXT[issue.type]) : issue.type}</span>
        <strong>{issue.title}</strong>
        {done && <span className="issue-status">{t(STATUS_TEXT[issue.status])}</span>}
      </div>
      {!done && (
        <>
          {issue.detail && <div className="issue-detail">{issue.detail}</div>}
          {issue.quote && <div className="issue-quote">{t('原文（{from}）：「{quote}」', { from: issue.from, quote: issue.quote })}</div>}
          {issue.suggestion && <div className="issue-suggestion">{t('AI 建議先：{suggestion}', { suggestion: issue.suggestion })}</div>}
          <div className="issue-actions">
            <input value={answer} placeholder={t('你知道答案就寫在這裡…')} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && set('answered', answer)} />
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => set('answered', answer)}>{t('回答')}</button>
            <button disabled={busy || !issue.suggestion} onClick={() => set('assumed')}>{t('照 AI 建議')}</button>
            <button disabled={busy} onClick={() => set('dismissed')}>{t('不是問題')}</button>
          </div>
        </>
      )}
      {done && (
        <div className="issue-detail">
          {issue.status === 'answered' && <>{issue.byDiscussion ? t('討論後釐清：{answer}', { answer: issue.answer ?? '' }) : t('你的回答：{answer}', { answer: issue.answer ?? '' })}</>}
          {issue.status === 'dismissed' && issue.answer && <>{issue.byDiscussion ? t('討論後判斷不是問題：{answer}', { answer: issue.answer }) : t('不是問題：{answer}', { answer: issue.answer })}</>}
          {issue.status === 'assumed' && <>{t('照 AI 建議：{suggestion}', { suggestion: issue.suggestion })}</>}
          <button className="link" disabled={busy} onClick={() => set('open')}>{t('重新打開')}</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function ReviewIssues({ review, onChange }: { review: Review; onChange(review: Review): void }) {
  const [text, setText] = useState('');
  const attach = useImageAttach({ onPaths: (paths) => setText((prev) => appendPaths(prev, paths)) });
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
        {open ? t('問題（{total}，{open} 個還沒處理）', { total: review.issues.length, open }) : t('問題（{total}）', { total: review.issues.length })}
        <span className="muted small review-meta">
          {LEVEL_TEXT[review.level] ? t(LEVEL_TEXT[review.level]) : t('{level}單', { level: review.level })} · {review.codeChecked ? t('有大略看程式碼') : t('只看單的內容')} · {t('問題不會擋住開發，沒處理的會告訴開發的 AI 先跳過或照建議做')}
        </span>
        {review.issues.some((i) => i.status === 'open') && (
          <button className="link" onClick={() => setDraft(pmDraft(review))} title={t('把還沒處理的問題整理成一段留言，複製貼到 Jira 問 PM')}>
            {t('產生給 PM 的留言')}
          </button>
        )}
        {openWithSuggestion.length > 1 && (
          <button className="link" disabled={busy} onClick={assumeAll}>
            {t('全部照 AI 建議（{count}）', { count: openWithSuggestion.length })}
          </button>
        )}
      </div>
      {draft !== null && (
        <div className="pm-draft">
          <div className="muted small">{t('給 PM 的留言（可以先改，再複製貼到 Jira；FlowPilot 不會自己發到 Jira）')}</div>
          <textarea rows={Math.min(14, draft.split('\n').length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => navigator.clipboard.writeText(draft).then(() => setCopied(true))}>{copied ? t('已複製') : t('複製')}</button>
            <button onClick={() => (setDraft(null), setCopied(false))}>{t('關閉')}</button>
          </div>
        </div>
      )}
      {review.issues.length === 0 && <p className="muted small">{t('AI 沒有發現明顯的問題。')}</p>}
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
          placeholder={t('跟 AI 討論這張單：追問、補充背景，或告訴它 PM 的回覆（Enter 送出，Shift＋Enter 換行）。可以附圖：按「附圖」、拖曳進來或直接貼上。AI 會一併更新上面的問題。')}
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
        <button className="primary" disabled={busy || (!text.trim() && !attach.images.length)} onClick={send}>{busy ? t('AI 思考中…') : t('送出')}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
