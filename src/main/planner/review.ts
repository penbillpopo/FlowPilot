// 審閱：讀懂單 → 判斷專案 → （一般、複雜的單）大略看一下程式碼 → 找出單子的問題。
// 問題不會擋住開發；你可以回答、照 AI 建議、或標成不是問題，也可以跟 AI 討論。
import type { CheckDecision, IssueType, JiraTicket, PlanEntry, Review, ReviewChecks, ReviewIssue } from '../../shared/types';
import type { IssueContext } from '../jira';
import type { Settings } from '../settings';
import { ticketKeys } from '../../shared/group';
import { fill } from './rules';
import { buildGroupJudgePrompt, buildJudgePrompt, JUDGE_INSTRUCTIONS, judgementSchema, sanitizeJudgement, type PastDecision } from './judge';

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

function checkSchema(description: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['need', 'reason'],
    description,
    properties: { need: { type: 'boolean' }, reason: { type: 'string', description: '為什麼要或不要（繁體中文，一句話）' } },
  };
}

export function reviewSchema(settings: Settings) {
  const base = judgementSchema(settings) as { required: string[]; properties: Record<string, unknown> };
  return {
    ...base,
    required: [...base.required, 'level', 'codeChecked', 'acceptance', 'pages', 'apis', 'steps', 'issues', 'complete', 'problem', 'checks'],
    properties: {
      ...base.properties,
      complete: { type: 'boolean', description: '這次審閱有沒有照要求完成（讀懂單、判斷專案；一般或複雜的單有看程式碼）' },
      checks: {
        type: 'object',
        additionalProperties: false,
        required: ['figma', 'codeReview', 'designCompare'],
        description: '檢查計畫：這張單需要哪些額外檢查（不是每張單都要，依單的內容判斷）',
        properties: {
          figma: checkSchema('審閱時對照 Figma 設計稿：單上有設計稿，而且是新畫面或流程、文案的改動才需要'),
          codeReview: checkSchema('開發完 AI 自我審查程式碼：改到多個檔案、牽涉 API、表單驗證或狀態邏輯才需要；單純的樣式、文字不用'),
          designCompare: checkSchema('測試時截圖跟設計稿比對：新畫面或版面有明顯改動、而且有設計稿才需要'),
        },
      },
      problem: { type: 'string', description: '沒完成的話，原因是什麼（繁體中文，一句話）；完成就給空字串' },
      acceptance: { type: 'array', items: { type: 'string' }, description: '預期結果逐條：把單上的「預期結果 / Acceptance Criteria」拆成一條一句（照原意，不要自己加）；單上沒有就從需求整理出可以驗證的幾條' },
      pages: { type: 'array', items: { type: 'string' }, description: '牽涉頁面：路由、選單、頁面或元件（看過程式碼就寫實際的路徑或元件名稱）' },
      apis: { type: 'array', items: { type: 'string' }, description: '後端 API 規格：單上（含內文、留言、文字附件）寫的方法、路徑、參數、回傳欄位；都沒寫就給空陣列，不要自己編' },
      steps: { type: 'array', items: { type: 'string' }, description: '預計執行內容：要改哪些地方、怎麼改，一項一句' },
      level: { type: 'string', enum: ['小', '一般', '複雜'], description: '小：單純的樣式、文字、顯示小修正；一般：一個畫面或功能的修改；複雜：多個畫面、新功能、牽涉 API 或權限' },
      codeChecked: { type: 'boolean', description: '這次有沒有實際看程式碼' },
      issues: { type: 'array', description: '單子本身的問題；沒有就給空陣列，不要硬湊', items: issueSchema },
    },
  };
}

export const REVIEW_INSTRUCTIONS = `${JUDGE_INSTRUCTIONS}

你同時也是幫前端工程師審閱需求的人：讀懂需求之後，找出單子本身的問題，讓工程師在開發前先知道。
- 問題類型：邏輯矛盾、需求不明確、遺漏情境（空資料、錯誤、權限、載入中…）、前後端對不上（欄位、API、錯誤處理）、跟設計稿不一致、範圍不清（哪些商戶、前後台要不要一起做）、跟現有功能衝突。
- 審閱的依據是「需求 / Requirements」與「預期結果 / Acceptance Criteria」：檢查需求本身有沒有矛盾或不清楚、預期結果有沒有寫到、兩者有沒有對不上（例如需求提到的行為在預期結果裡沒有、或反過來）。
- 不要拿「原始需求 / Merchant Requirements」來比對或當成問題（那一段已經拿掉）。
- 只列真正會影響開發的問題；不要為了列而列，沒有就給空陣列。最多 6 個，重要的排前面。
- 每個問題都要給「建議先怎麼做」，因為工程師會先做沒有爭議的部分，不會等 PM 回覆。
- 先判斷單的大小（level）：
  - 小：不用看程式碼，只根據單的內容審閱。
  - 一般或複雜：到判斷出的專案資料夾裡「大略」看程式碼，只做三件事：找到相關的頁面或模組、確認單上提到的欄位或 API 在程式碼裡大概有沒有、看看有沒有明顯會互相影響的地方。
  - 看程式碼只看大方向：最多執行 12 個查詢或讀檔指令，不要逐行細讀，整體控制在一分鐘內。
  - 資料夾可能停在任何分支（常常是別張單、別的商戶），不要看工作目錄裡的檔案。一律用 git 直接讀這張單要開發的商戶的「遠端基底分支」，不用切換分支：
    git grep -n 關鍵字 origin/<基底分支> -- src、git show origin/<基底分支>:檔案路徑、git ls-tree -r --name-only origin/<基底分支> -- 資料夾
    各專案的基底分支寫在下面的資料夾清單。
  - 多商戶的專案（例如 PlatformWeb）：各商戶的程式可能不一樣（實際發生過：新版獎金中心 /bonuses 只有 m8、m10 有，其他商戶是舊的 /voucher/bonus）。
    先決定要做哪些商戶，再把相關頁面或模組在「每個選到的商戶」的基底分支都查一次（git grep 一次查多個分支就好，例如 git grep -n 關鍵字 origin/master-1 origin/master-8 -- src）。
    sourceMerchant（來源商戶，先開發、再移植到其他商戶）選「程式最符合需求」的那個，例如需求說的頁面只有某些商戶有，就選其中一個；都一樣才照預設的優先順序。
    各商戶的結構不一樣時，一定要列一個「範圍不清」的問題，寫出哪些商戶有、哪些沒有、建議怎麼做；pages 也寫清楚是哪個商戶的路徑。
  - 只能讀，不能修改任何檔案。
- 審閱結果會整理成開發用的需求分析交給開發的 AI，所以也要填：
  - pages（牽涉頁面）：路由、選單、頁面或元件；看過程式碼就寫實際的路徑或元件名稱。
  - apis（後端 API 規格）：單上寫的方法、路徑、參數、回傳欄位。API 規格常寫在附件（.md、.txt）裡，資料中有「附件…的內容」時一定要看；都沒寫就給空陣列，不要自己編。
  - steps（預計執行內容）：要改哪些地方、怎麼改，一項一句。
- 有附圖片時一起看：只比對流程和描述（單上寫的跟圖上畫的是不是同一件事、步驟有沒有對不上），間距、排版、顏色這類細節不用管；差很多才列成「跟設計稿不一致」的問題。
- 看子單的狀態：需求要串的 API 是由 BE 子單（標題常有 [BE]、[API]、後端）提供的，如果那張子單還沒完成（不是完成、Done、已解決、UAT 之類的狀態），就列一個「前後端對不上」的問題說明後端可能還沒好，建議先把畫面接出來。
- 檢查計畫（checks）：判斷這張單需不需要三種額外檢查，每項都要寫理由；不需要就填 false，不要每張都勾。
- 不要使用任何技能（skills），也不要去讀任何 SKILL.md；照這裡的說明做就好。
- 照實回報：沒有看程式碼就把 codeChecked 填 false；有任何一步沒做到（例如讀不到程式碼、資料不足），complete 填 false，problem 寫原因。不要把「我還沒做、需要你提供什麼」寫進 summary 或其他欄位。`;

function folderList(settings: Settings): string {
  return Object.entries(settings.projects)
    .map(([project, rule]) => {
      const folder = settings.folders.find((f) => f.project === project);
      return folder ? `- ${project}：${folder.path}（${baseBranchHint(rule)}）` : null;
    })
    .filter(Boolean)
    .join('\n');
}

const FOLDERS_TITLE = '## 各專案的程式碼資料夾（一般、複雜的單才需要看；用 git 讀括號裡的遠端基底分支，不要看工作目錄）';

export function buildReviewPrompt(
  ticket: JiraTicket,
  sub: IssueContext,
  main: IssueContext | null,
  settings: Settings,
  history: PastDecision[],
): string {
  return [buildJudgePrompt(ticket, sub, main, settings, history), '', FOLDERS_TITLE, folderList(settings)].join('\n');
}

/** 好幾張單合成一個任務的審閱：每張子任務和（不重複的）主單都給 AI 看 */
export function buildGroupReviewPrompt(ticket: JiraTicket, subs: IssueContext[], mains: IssueContext[], settings: Settings, history: PastDecision[]): string {
  return [buildGroupJudgePrompt(ticket, subs, mains, settings, history), '', FOLDERS_TITLE, folderList(settings)].join('\n');
}

/** 基底分支怎麼來：多商戶的寫出規則和例子（例如 master-{商戶}，m1 是 origin/master-1） */
function baseBranchHint(rule: Settings['projects'][string]): string {
  if (!rule.merchants?.length) return `基底分支 origin/${rule.baseBranch}`;
  const examples = rule.merchants.slice(0, 3).map((m) => `m${m} 是 origin/${fill(rule.baseBranch, { merchant: m, key: '' })}`).join('、');
  return `多商戶，基底分支 ${rule.baseBranch}：${examples}…；預設的來源商戶優先順序 ${(rule.sourcePriority ?? []).join(' > ') || '數字小的'}`;
}

/** 一般、複雜的單 AI 第一輪沒看程式碼時，追加的這一輪：指定到判斷出的專案、商戶的基底分支大略看 */
export function buildCodeCheckPrompt(entries: PlanEntry[], settings: Settings): string | null {
  const lines = entries
    .map((e) => {
      const folder = settings.folders.find((f) => f.project === e.project);
      const rule = settings.projects[e.project];
      if (!folder || !rule) return null;
      const bases = rule.merchants?.length && e.merchants.length
        ? e.merchants.map((m) => `m${m}：origin/${fill(rule.baseBranch, { merchant: m, key: '' })}`).join('、')
        : `origin/${rule.baseBranch}`;
      return `- ${e.project}：${folder.path}（用 git 讀這些分支，不要看工作目錄：${bases}）`;
    })
    .filter(Boolean);
  if (!lines.length) return null;
  return [
    '這張單不是小單，請「大略」看一下程式碼，然後回傳完整的審閱結果（同樣的格式；有看程式碼 codeChecked 才填 true）：',
    ...lines,
    '多商戶的話每個選到的商戶都查一次，結構不一樣就列成問題，並照「程式最符合需求」選 sourceMerchant。',
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
  // 合成任務的標題列出全部單號：feat(ALL-1, ALL-2) …
  const judgement = sanitizeJudgement(raw, ticketKeys(ticket), settings);
  const level = ['小', '一般', '複雜'].includes(raw?.level) ? raw.level : '一般';
  const issues = (raw?.issues ?? [])
    .map((i: Partial<ReviewIssue>) => sanitizeIssue(i, ticket.key))
    .filter(Boolean)
    .slice(0, ticket.members?.length ? 10 : 6) as ReviewIssue[];
  issues.sort((a, b) => (a.importance === b.importance ? 0 : a.importance === '重要' ? -1 : 1));
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    ...judgement,
    ticketKey: ticket.key,
    level,
    codeChecked: !!raw?.codeChecked,
    checks: sanitizeChecks(raw?.checks, level),
    // 舊的結果沒有這個欄位，當成完成
    complete: raw?.complete !== false,
    problem: raw?.complete === false ? String(raw?.problem ?? '').trim() || '原因不明' : '',
    acceptance: list(raw?.acceptance),
    pages: list(raw?.pages),
    apis: list(raw?.apis),
    steps: list(raw?.steps),
    issues,
    discussion: [],
    reviewedAt: now.toISOString(),
  };
}

function sanitizeChecks(raw: any, level: Review['level']): ReviewChecks {
  const one = (x: any, fallback: boolean): CheckDecision => ({ need: typeof x?.need === 'boolean' ? x.need : fallback, reason: String(x?.reason ?? '').trim() });
  return { figma: one(raw?.figma, false), codeReview: one(raw?.codeReview, level !== '小'), designCompare: one(raw?.designCompare, false) };
}

/** 檢查計畫要對照 Figma、單上也有 Figma 連結時，追加的這一輪 */
export function buildFigmaPrompt(figmaUrls: string[]): string {
  return [
    '請用 Figma 工具看下面的設計稿（最多查 3 次，例如取節點的截圖或結構），對照單上的需求，然後回傳完整的審閱結果（同樣的格式）：',
    ...figmaUrls.map((u) => `- ${u}`),
    '',
    '只看流程和描述：單上寫的跟設計稿畫的是不是同一件事、流程步驟、欄位、按鈕、文案有沒有明顯對不上。間距、排版、顏色、字級這類細節一律不管。',
    '差很多的地方列成「跟設計稿不一致」的問題（附上建議先照哪一個做）；一致就不用列。看不到設計稿（例如沒有權限）就照實在 problem 說明，complete 填 false。',
  ].join('\n');
}

// ---- 討論 ----

export const discussionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'resolved', 'dismissed', 'newIssues'],
  properties: {
    reply: { type: 'string', description: '用繁體中文回覆工程師' },
    resolved: {
      type: 'array',
      description: '已經釐清的問題（工程師回答了，或你查證後確定了答案、工程師也沒有異議），用問題編號，附上結論',
      items: { type: 'object', additionalProperties: false, required: ['id', 'answer'], properties: { id: { type: 'string' }, answer: { type: 'string' } } },
    },
    dismissed: {
      type: 'array',
      description: '討論後確定其實不是問題的（例如程式已經處理了、不在這張單的範圍、誤會了需求），用問題編號，附上理由；沒有就給空陣列',
      items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } },
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
    '工程師在討論這張單。請回覆他，並整理問題清單（每個還沒處理的問題都想一下這次討論後還算不算問題）：',
    '- 已經釐清的放進 resolved（用問題編號），附上結論：他的話回答了，或你查證後（例如看了程式碼、讀了補充資料）確定了答案、他也沒有異議。',
    '- 討論後確定其實不是問題的放進 dismissed，附上理由：例如程式已經處理了、不在這張單的範圍、原本誤會了需求。',
    '- 還有疑慮、需要 PM 決定的，不要放進去，留著。',
    '- 討論中發現新的問題，放進 newIssues；沒有就給空陣列。',
    '- 需要的話可以再看程式碼（只讀，看大方向）。',
    '- reply 的最後一行列出這次處理了哪些問題，例如「已釐清：…；不是問題：…」；沒有處理就不用寫。',
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
  result: { reply: string; resolved: { id: string; answer: string }[]; dismissed?: { id: string; reason: string }[]; newIssues: Partial<ReviewIssue>[] },
  now = new Date(),
): Review {
  const issues = review.issues.map((issue) => {
    // 你已經處理過的（回答、照建議、不是問題）不會被討論改掉；只處理還沒處理的
    if (issue.status !== 'open') return issue;
    const hit = result.resolved?.find((r) => r.id === issue.id);
    if (hit) return { ...issue, status: 'answered' as const, answer: hit.answer, byDiscussion: true };
    const gone = result.dismissed?.find((r) => r.id === issue.id);
    if (gone) return { ...issue, status: 'dismissed' as const, answer: gone.reason, byDiscussion: true };
    return issue;
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

/**
 * 交給開發的 AI：整理成開發技能（frontend-development）需要的五段需求分析。
 * 沒有審閱結果時回傳空字串，由呼叫端請 AI 自己讀單整理。
 */
export function reviewBrief(review: Review | null): string {
  if (!review) return '';
  const bullets = (items: string[] | undefined, empty: string) => (items?.length ? items.map((t) => `- ${t}`) : [`- ${empty}`]);
  const confirmed = review.issues.filter((i) => i.status === 'answered' || i.status === 'assumed');
  const open = review.issues.filter((i) => i.status === 'open');
  const questions: string[] = [];
  for (const i of confirmed) questions.push(`- （已確認，照這個做）${i.title} → ${i.status === 'answered' ? i.answer : `暫定：${i.suggestion}`}`);
  for (const i of open) questions.push(`- （還沒確認，不擋開發：先做沒有爭議的部分，這點照建議做並在回覆中標示是暫定的）${i.title}（建議：${i.suggestion}）`);
  return [
    '',
    '## 需求分析（開發前已經跟我一起審閱過，這就是開發用的需求分析，不用再跑 jira-frontend-analysis）',
    '',
    '### 1. 開發內容重點',
    ...bullets(review.summary, '（見 Jira 單的需求與預期結果）'),
    ...(review.acceptance?.length ? ['', '預期結果（逐條，完成時要一條一條對照）：', ...review.acceptance.map((a, i) => `${i + 1}. ${a}`)] : []),
    '',
    '### 2. 牽涉頁面',
    ...bullets(review.pages, '（審閱時沒有確定，請看程式碼找出來）'),
    '',
    '### 3. 後端API規格',
    ...bullets(review.apis, '單上沒有寫 API 規格'),
    '',
    '### 4. 預計執行內容',
    ...bullets(review.steps, '（請依需求自行規劃）'),
    '',
    '### 5. 疑問',
    ...(questions.length ? questions : ['- 沒有']),
    ...(review.supplements?.length
      ? ['', '### 6. 補充資料（我另外提供的需求來源，跟 Jira 單一樣重要；附的截圖也一起看）', ...review.supplements.flatMap((s) => ['', `【${s.label}】`, s.text])]
      : []),
  ].join('\n');
}
