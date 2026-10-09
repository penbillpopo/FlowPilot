import { describe, expect, it } from 'vitest';
import { applyDiscussion, buildDiscussionPrompt, buildReviewPrompt, reviewBrief, reviewSchema, sanitizeReview } from '../src/main/planner/review';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import type { JiraTicket } from '../src/shared/types';

const settings = parseSettings(DEFAULT_SETTINGS_YAML);
const ticket: JiraTicket = { key: 'ALL-14324', summary: '彈窗 Banner 增加存款次數顯示條件', status: '進行中', issueType: '子任務', updated: '', url: '', parent: null };

const raw = {
  entries: [{ project: 'PlatformAdmin', merchants: [], reason: '後台設定' }],
  prTitle: 'feat(ALL-1) add deposit status',
  reason: '後台',
  summary: ['新增存款狀態設定'],
  level: '一般',
  codeChecked: true,
  issues: [
    { type: '遺漏情境', importance: '一般', title: '沒寫空資料時的顯示', detail: '', quote: '單上沒有提到', from: '', suggestion: '顯示空狀態' },
    { type: '需求不明確', importance: '重要', title: '「X 天」含不含當天', detail: '影響判斷', quote: '距離上次存款 X 天', from: 'ALL-12747', suggestion: '含當天、台北時間' },
    { type: '奇怪的類型', importance: '超重要', title: '類型不認得時當成需求不明確', detail: '', quote: '', from: '', suggestion: '' },
    { title: '' },
  ],
};

describe('審閱', () => {
  it('輸出格式在判斷之外多了大小、有沒有看程式碼、問題清單', () => {
    const schema = reviewSchema(settings) as any;
    expect(schema.required).toEqual(expect.arrayContaining(['entries', 'summary', 'level', 'codeChecked', 'issues']));
    expect(schema.properties.issues.items.properties.type.enum).toContain('跟現有功能衝突');
  });

  it('提示內容附上各專案的程式碼資料夾', () => {
    const issue = { key: 'ALL-14324', summary: '', issueType: '', description: '', comments: [], subtasks: [], resources: [] };
    expect(buildReviewPrompt(ticket, issue, null, settings, [])).toContain('PlatformAdmin：');
  });

  it('整理問題：重要的排前面、不認得的類型改成需求不明確、空的丟掉、補上出處與編號', () => {
    const review = sanitizeReview(raw, ticket, settings, new Date('2026-10-10T00:00:00Z'));
    expect(review).toMatchObject({ ticketKey: 'ALL-14324', level: '一般', codeChecked: true, reviewedAt: '2026-10-10T00:00:00.000Z' });
    expect(review.issues.map((i) => [i.importance, i.type, i.from, i.status])).toEqual([
      ['重要', '需求不明確', 'ALL-12747', 'open'],
      ['一般', '遺漏情境', 'ALL-14324', 'open'],
      ['一般', '需求不明確', 'ALL-14324', 'open'],
    ]);
    expect(new Set(review.issues.map((i) => i.id)).size).toBe(3);
  });

  it('討論：回答了的問題標成已回答（你標成不是問題的不會被改回來），新問題加進來', () => {
    let review = sanitizeReview(raw, ticket, settings);
    const [important, empty, odd] = review.issues;
    review.issues[2] = { ...odd, status: 'dismissed' };
    expect(buildDiscussionPrompt(review, 'X 天含當天')).toContain(`[${important.id}]`);
    review = applyDiscussion(review, 'X 天含當天', {
      reply: '了解',
      resolved: [{ id: important.id, answer: '含當天' }, { id: odd.id, answer: '不該被套用' }],
      newIssues: [{ type: '範圍不清', importance: '一般', title: '其他商戶要不要做', detail: '', quote: '', from: '', suggestion: '只做 M1' }],
    });
    expect(review.issues.find((i) => i.id === important.id)).toMatchObject({ status: 'answered', answer: '含當天' });
    expect(review.issues.find((i) => i.id === odd.id)?.status).toBe('dismissed');
    expect(review.issues.at(-1)).toMatchObject({ title: '其他商戶要不要做', status: 'open' });
    expect(review.discussion.map((d) => d.role)).toEqual(['you', 'ai']);

    // 交給開發的 AI：已確認（回答、照建議）與還沒確認，不列「不是問題」
    review.issues = review.issues.map((i) => (i.id === empty.id ? { ...i, status: 'assumed' } : i));
    const brief = reviewBrief(review);
    expect(brief).toContain('「X 天」含不含當天 → 含當天');
    expect(brief).toContain('沒寫空資料時的顯示 → 暫定：顯示空狀態');
    expect(brief).toContain('其他商戶要不要做（建議：只做 M1）');
    expect(brief).not.toContain('類型不認得');
  });
});
