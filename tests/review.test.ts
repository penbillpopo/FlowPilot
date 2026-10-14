import { describe, expect, it } from 'vitest';
import { applyDiscussion, buildCodeCheckPrompt, buildDiscussionPrompt, buildFigmaPrompt, buildReviewPrompt, REVIEW_INSTRUCTIONS, reviewBrief, reviewSchema, sanitizeReview } from '../src/main/planner/review';
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
    const issue = { key: 'ALL-14324', summary: '', issueType: '', description: '', comments: [], subtasks: [], resources: [], textAttachments: [], imageAttachments: [], snapshot: { key: 'ALL-14575', summary: '', description: '', comments: [], attachments: [], takenAt: '' } };
    expect(buildReviewPrompt(ticket, issue, null, settings, [])).toContain('PlatformAdmin：');
  });

  it('看程式碼用 git 讀這張單要開發的商戶的遠端基底分支，不看資料夾當時剛好在的分支', () => {
    const issue = { key: 'ALL-1', summary: '', issueType: '', description: '', comments: [], subtasks: [], resources: [], textAttachments: [], imageAttachments: [], snapshot: { key: 'ALL-1', summary: '', description: '', comments: [], attachments: [], takenAt: '' } };
    const prompt = buildReviewPrompt(ticket, issue, null, settings, []);
    expect(prompt).toContain('m1 是 origin/master-1');
    expect(prompt).toContain('用 git 讀括號裡的遠端基底分支');
    expect(REVIEW_INSTRUCTIONS).toContain('不要看工作目錄裡的檔案');
    expect(REVIEW_INSTRUCTIONS).toContain('每個選到的商戶');
    // 追加看程式碼的那一輪：列出每個選到的商戶的基底分支
    const code = buildCodeCheckPrompt([{ project: 'PlatformWeb', merchants: [1, 8], sourceMerchant: 8, reason: '' }], settings)!;
    expect(code).toContain('m1：origin/master-1、m8：origin/master-8');
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

  it('討論後 AI 釐清的標成已解決、判斷不是問題的標成不是問題（附理由）；你已經處理過的不會被改', () => {
    let review = sanitizeReview(raw, ticket, settings);
    const [a, b, c] = review.issues;
    review.issues[2] = { ...c, status: 'assumed' };
    review = applyDiscussion(review, '程式裡已經有空狀態了嗎？', {
      reply: '查過程式碼了。\n已釐清：…；不是問題：…',
      resolved: [{ id: a.id, answer: '含當天（程式裡的計算已經含）' }],
      dismissed: [{ id: b.id, reason: '空狀態元件已經處理了' }, { id: c.id, reason: '不該套用到你處理過的' }],
      newIssues: [],
    });
    expect(review.issues.find((i) => i.id === a.id)).toMatchObject({ status: 'answered', byDiscussion: true });
    expect(review.issues.find((i) => i.id === b.id)).toMatchObject({ status: 'dismissed', answer: '空狀態元件已經處理了', byDiscussion: true });
    expect(review.issues.find((i) => i.id === c.id)).toMatchObject({ status: 'assumed' });
    expect(buildDiscussionPrompt(review, 'x')).toContain('dismissed');
    // 交給開發的 AI：討論後判斷不是問題的不列
    expect(reviewBrief(review)).not.toContain('空狀態元件已經處理了');
  });

  it('交給開發的需求分析是五段格式；單上沒寫 API 就照實說，不編', () => {
    const review = sanitizeReview({ ...raw, pages: ['src/app/pages/banner'], apis: [], steps: ['新增存款次數欄位', ''] }, ticket, settings);
    expect(review.pages).toEqual(['src/app/pages/banner']);
    expect(review.steps).toEqual(['新增存款次數欄位']);
    const brief = reviewBrief(review);
    const order = ['### 1. 開發內容重點', '### 2. 牽涉頁面', '### 3. 後端API規格', '### 4. 預計執行內容', '### 5. 疑問'].map((h) => brief.indexOf(h));
    expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]))).toBe(true);
    expect(brief).toContain('- 新增存款狀態設定');
    expect(brief).toContain('- 單上沒有寫 API 規格');
    expect(brief).toContain('不用再跑 jira-frontend-analysis');
    expect(reviewBrief(null)).toBe('');
  });

  it('AI 回報沒完成：記下原因；舊的結果沒有這個欄位就當成完成；要求不用技能、照實回報', () => {
    expect(sanitizeReview({ ...raw, complete: false, problem: '讀不到程式碼' }, ticket, settings)).toMatchObject({ complete: false, problem: '讀不到程式碼' });
    expect(sanitizeReview({ ...raw, complete: false }, ticket, settings).problem).toBe('原因不明');
    expect(sanitizeReview(raw, ticket, settings)).toMatchObject({ complete: true, problem: '' });
    expect((reviewSchema(settings) as any).required).toEqual(expect.arrayContaining(['complete', 'problem']));
    expect(REVIEW_INSTRUCTIONS).toContain('不要使用任何技能');
  });

  it('檢查計畫：照 AI 的判斷；沒給就照單的大小給預設（一般、複雜的單才自我審查）', () => {
    const withChecks = sanitizeReview({ ...raw, checks: { figma: { need: true, reason: '有設計稿' }, codeReview: { need: false, reason: '只改文字' }, designCompare: { need: false, reason: '' } } }, ticket, settings);
    expect(withChecks.checks).toEqual({ figma: { need: true, reason: '有設計稿' }, codeReview: { need: false, reason: '只改文字' }, designCompare: { need: false, reason: '' } });
    expect(sanitizeReview(raw, ticket, settings).checks?.codeReview.need).toBe(true); // raw 是一般單
    expect(sanitizeReview({ ...raw, level: '小' }, ticket, settings).checks?.codeReview.need).toBe(false);
    expect(buildFigmaPrompt(['https://figma.com/x'])).toContain('間距、排版、顏色、字級這類細節一律不管');
  });
});
