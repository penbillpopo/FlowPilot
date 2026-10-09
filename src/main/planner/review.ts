// 審閱：讀懂單 → 判斷專案 → （一般、複雜的單）大略看一下程式碼 → 找出單子的問題。
// 問題不會擋住開發；你可以回答、照 AI 建議、或標成不是問題，也可以跟 AI 討論。
import type { IssueType, JiraTicket, Review, ReviewIssue } from '../../shared/types';
import type { IssueContext } from '../jira';
import type { Settings } from '../settings';
import { buildJudgePrompt, JUDGE_INSTRUCTIONS, judgementSchema, sanitizeJudgement, type PastDecision } from './judge';

export const ISSUE_TYPES: IssueType[] = ['邏輯矛盾', '需求不明確', '遺漏情境', '前後端對不上', '跟設計稿不一致', '範圍不清', '跟現有功能衝突'];

const issueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'importance', 'title', 'detail', 'quote', 'from', 'suggestion'],
  properties: {
    type: { type: 'string', enum: ISSUE_TYPES },
    importance: { type: 'string', enum: ['重要', '一般'], description: '重要：照字面做下去很可能做錯；一般：可以先照建議做' },
    title: { type: 'string', description: '一句話說出問題（繁體中文）' },
    detail: { type: 'string', description: '為什麼是問題、會造成什麼影響（繁體中文，簡短）' },
    quote: { type: 'string', description: '單上相關的原文（照抄），沒有原文就寫「單上沒有提到」' },
    from: { type: 'string', description: '出自哪張單的單號' },
    suggestion: { type: 'string', description: 'PM 還沒回之前，建議先怎麼做（繁體中文）' },
  },
};

export function reviewSchema(settings: Settings) {
  const base = judgementSchema(settings) as { required: string[]; properties: Record<string, unknown> };
  return {
    ...base,
    required: [...base.required, 'level', 'codeChecked', 'issues'],
    properties: {
      ...base.properties,
      level: { type: 'string', enum: ['小', '一般', '複雜'], description: '小：單純的樣式、文字、顯示小修正；一般：一個畫面或功能的修改；複雜：多個畫面、新功能、牽涉 API 或權限' },
      codeChecked: { type: 'boolean', description: '這次有沒有實際看程式碼' },
      issues: { type: 'array', description: '單子本身的問題；沒有就給空陣列，不要硬湊', items: issueSchema },
    },
  };
}

export const REVIEW_INSTRUCTIONS = `${JUDGE_INSTRUCTIONS}

你同時也是幫前端工程師審閱需求的人：讀懂需求之後，找出單子本身的問題，讓工程師在開發前先知道。
- 問題類型：邏輯矛盾、需求不明確、遺漏情境（空資料、錯誤、權限、載入中…）、前後端對不上（欄位、API、錯誤處理）、跟設計稿不一致、範圍不清（哪些商戶、前後台要不要一起做）、跟現有功能衝突。
- 只列真正會影響開發的問題；不要為了列而列，沒有就給空陣列。最多 6 個，重要的排前面。
- 每個問題都要給「建議先怎麼做」，因為工程師會先做沒有爭議的部分，不會等 PM 回覆。
- 先判斷單的大小（level）：
  - 小：不用看程式碼，只根據單的內容審閱。
  - 一般或複雜：到判斷出的專案資料夾裡「大略」看程式碼，只做三件事：找到相關的頁面或模組、確認單上提到的欄位或 API 在程式碼裡大概有沒有、看看有沒有明顯會互相影響的地方。
  - 看程式碼只看大方向：最多執行 10 個查詢或讀檔指令，不要逐行細讀，整體控制在一分鐘內。資料夾目前可能停在別的分支，只當作參考。
  - 只能讀，不能修改任何檔案。`;

export function buildReviewPrompt(
  ticket: JiraTicket,
  sub: IssueContext,
  main: IssueContext | null,
  settings: Settings,
  history: PastDecision[],
): string {
  const folders = Object.keys(settings.projects)
    .map((project) => {
      const folder = settings.folders.find((f) => f.project === project);
      return folder ? `- ${project}：${folder.path}` : null;
    })
    .filter(Boolean)
    .join('\n');
  return [buildJudgePrompt(ticket, sub, main, settings, history), '', '## 各專案的程式碼資料夾（一般、複雜的單才需要看）', folders].join('\n');
}

/** 一般、複雜的單 AI 第一輪沒看程式碼時，追加的這一輪：指定到判斷出的專案資料夾大略看 */
export function buildCodeCheckPrompt(projects: string[], settings: Settings): string | null {
  const folders = projects.map((p) => settings.folders.find((f) => f.project === p)).filter(Boolean);
  if (!folders.length) return null;
  return [
    '這張單不是小單，請到下面的資料夾「大略」看一下程式碼，然後回傳完整的審閱結果（同樣的格式，codeChecked 填 true）：',
    ...folders.map((f) => `- ${f!.project}：${f!.path}`),
    '',
    '只做三件事：找到相關的頁面或模組、確認單上提到的欄位或 API 在程式碼裡大概有沒有、看看有沒有明顯會互相影響的地方。',
    '最多執行 10 個查詢或讀檔指令（例如 rg 搜尋關鍵字、看相關檔案的開頭），不要逐行細讀；只能讀，不能修改。',
    '看完之後，補充或修正問題清單：程式碼證實不是問題的拿掉，新發現的加進來。其他欄位（專案、要做什麼…）有需要也可以修正。',
  ].join('\n');
}

let nextId = 0;
const newId = () => `i${Date.now().toString(36)}${(nextId++).toString(36)}`;

function sanitizeIssue(raw: Partial<ReviewIssue>, fallbackFrom: string): ReviewIssue | null {
  if (!raw?.title) return null;
  return {
    id: newId(),
    type: ISSUE_TYPES.includes(raw.type as IssueType) ? (raw.type as IssueType) : '需求不明確',
    importance: raw.importance === '重要' ? '重要' : '一般',
    title: String(raw.title).trim(),
    detail: String(raw.detail ?? '').trim(),
    quote: String(raw.quote ?? '').trim(),
    from: String(raw.from ?? '').trim() || fallbackFrom,
    suggestion: String(raw.suggestion ?? '').trim(),
    status: 'open',
  };
}

export function sanitizeReview(raw: any, ticket: JiraTicket, settings: Settings, now = new Date()): Review {
  const judgement = sanitizeJudgement(raw, ticket.key, settings);
  const level = ['小', '一般', '複雜'].includes(raw?.level) ? raw.level : '一般';
  const issues = (raw?.issues ?? [])
    .map((i: Partial<ReviewIssue>) => sanitizeIssue(i, ticket.key))
    .filter(Boolean)
    .slice(0, 6) as ReviewIssue[];
  issues.sort((a, b) => (a.importance === b.importance ? 0 : a.importance === '重要' ? -1 : 1));
  return { ...judgement, ticketKey: ticket.key, level, codeChecked: !!raw?.codeChecked, issues, discussion: [], reviewedAt: now.toISOString() };
}

// ---- 討論 ----

export const discussionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'resolved', 'newIssues'],
  properties: {
    reply: { type: 'string', description: '用繁體中文回覆工程師' },
    resolved: {
      type: 'array',
      description: '這次討論中已經有答案的問題（用問題編號），附上答案',
      items: { type: 'object', additionalProperties: false, required: ['id', 'answer'], properties: { id: { type: 'string' }, answer: { type: 'string' } } },
    },
    newIssues: { type: 'array', description: '討論中新發現的問題；沒有就給空陣列', items: issueSchema },
  },
};

const STATUS_TEXT: Record<ReviewIssue['status'], string> = { open: '還沒處理', answered: '已回答', assumed: '照建議做', dismissed: '不是問題' };

export function buildDiscussionPrompt(review: Review, text: string): string {
  const list = review.issues
    .map((i) => `- [${i.id}] ${i.title}（${STATUS_TEXT[i.status]}${i.answer ? `：${i.answer}` : ''}）`)
    .join('\n');
  return [
    '工程師在討論這張單。請回覆他，並更新問題清單：',
    '- 他的話如果回答了某個問題，放進 resolved（用問題編號），附上答案。',
    '- 討論中發現新的問題，放進 newIssues；沒有就給空陣列。',
    '- 需要的話可以再看程式碼（只讀，看大方向）。',
    '',
    '## 目前的問題清單',
    list || '（沒有）',
    '',
    '## 工程師說',
    text,
  ].join('\n');
}

export function applyDiscussion(
  review: Review,
  text: string,
  result: { reply: string; resolved: { id: string; answer: string }[]; newIssues: Partial<ReviewIssue>[] },
  now = new Date(),
): Review {
  const issues = review.issues.map((issue) => {
    const hit = result.resolved?.find((r) => r.id === issue.id);
    // 你標成「不是問題」的不會被改回來
    return hit && issue.status !== 'dismissed' ? { ...issue, status: 'answered' as const, answer: hit.answer } : issue;
  });
  for (const raw of result.newIssues ?? []) {
    const issue = sanitizeIssue(raw, review.ticketKey);
    if (issue && !issues.some((i) => i.title === issue.title)) issues.push(issue);
  }
  return {
    ...review,
    issues,
    discussion: [...review.discussion, { role: 'you', text, at: now.toISOString() }, { role: 'ai', text: result.reply, at: now.toISOString() }],
  };
}

/** 交給開發的 AI：已確認的事項與還沒確認的問題 */
export function reviewBrief(review: Review | null): string {
  if (!review) return '';
  const confirmed = review.issues.filter((i) => i.status === 'answered' || i.status === 'assumed');
  const open = review.issues.filter((i) => i.status === 'open');
  if (!confirmed.length && !open.length) return '';
  const lines = ['', '## 開發前審閱的結果'];
  if (confirmed.length) {
    lines.push('已確認（照這些做）：');
    for (const i of confirmed) lines.push(`- ${i.title} → ${i.status === 'answered' ? i.answer : `暫定：${i.suggestion}`}`);
  }
  if (open.length) {
    lines.push('還沒確認（先做沒有爭議的部分；這些點先跳過，或照建議做並在回覆中清楚標示是暫定的）：');
    for (const i of open) lines.push(`- ${i.title}（建議：${i.suggestion}）`);
  }
  return lines.join('\n');
}
