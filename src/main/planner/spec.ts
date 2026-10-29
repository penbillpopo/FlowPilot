// 規格流程（Google 的 Elephant-Goldfish Model，https://github.com/google/elephant-goldfish-model）：
// 1. 寫規格（Elephant）：審閱完，接著同一套資料把單寫成規格，不准發明後端、不知道的寫成待確認問題。
// 2. 沒看過的 AI 審查（Goldfish）：四個角色各開一段全新的唯讀對話，只拿到規格和程式碼，看不到單和任何討論。
// 3. 處理意見：回到寫規格的那段對話，逐條照改、反駁（附證據）或問你；只有產品上要你決定的才會變成問題。
// 4. 做完後比對：開發完，再開一段全新的對話拿規格比對改動；做錯的交回開發的 AI 修，不確定誰對的給你看。
// 為什麼要做：開發的 AI 遇到單上沒寫清楚的地方，常常自己默默挑一個做法、也不說（實際發生過：只看有沒有 POA 圖片就顯示，
// 沒看 POA 有沒有通過，開發、自動測試、驗收都沒發現）。同一個 AI 回頭檢查自己會替自己找理由，要沒有背景的 AI 才看得出來。
// 不用 Codex 的子 AI（spawn_agent）：子 AI 要求同意時 FlowPilot 認不得、兩邊互等卡住（實際卡過 20 分鐘）。
import { t, zhOnly } from '../../shared/i18n';
import type { Review, ReviewIssue, Spec, SpecCheck, SpecCheckItem, SpecFinding } from '../../shared/types';
import { wantsSpec } from '../../shared/types';
import type { CodexRpc } from '../codex/rpc';
import { runStructured } from '../codex/structured';
import type { Settings } from '../settings';
import { codeLocations, reviewBrief } from './review';
import zoomOut from './egm/zoom_out.md?raw';
import designCritic from './egm/design_critic.md?raw';
import readiness from './egm/implementation_readiness.md?raw';
import codebase from './egm/codebase_details.md?raw';
import zoomOutStandard from './egm/zoom-out-standard.md?raw';
import featureStandard from './egm/feature-spec-standard.md?raw';
import readinessStandard from './egm/implementation-readiness-standard.md?raw';

/** 四個審查角色：EGM 的原文角色＋評分標準（設計文件審查裡跟前端單有關的四個） */
export const SPEC_REVIEWERS = [
  { key: 'zoomOut', persona: zoomOut, standard: zoomOutStandard },
  { key: 'designCritic', persona: designCritic, standard: featureStandard },
  { key: 'readiness', persona: readiness, standard: readinessStandard },
  { key: 'codebase', persona: codebase, standard: readinessStandard },
] as const;

const SEVERITIES = ['Blocker', 'Major', 'Nit'] as const;

/** Jira 原文（審閱時存的快照）：太長的截掉，避免整份規格的對話被單子塞滿 */
function ticketText(review: Review): string {
  const parts = (review.snapshot ?? []).map((s) => {
    const comments = s.comments.slice(-10).map((c) => `- ${c.author}：${c.text.slice(0, 1500)}`).join('\n');
    return [`### ${s.key} ${s.summary}`, s.description.slice(0, 8000), comments ? `留言：\n${comments}` : ''].filter(Boolean).join('\n');
  });
  return parts.join('\n\n').slice(0, 24000) || '（沒有存到單的原文，以上面的需求分析為準）';
}

function locationText(review: Review, settings: Settings): string {
  const lines = codeLocations(review.entries, settings);
  return lines.length
    ? [...lines, '讀法：git -C <資料夾> grep -n 關鍵字 <分支> -- src、git -C <資料夾> show <分支>:檔案路徑、git -C <資料夾> ls-tree -r --name-only <分支> -- 資料夾。資料夾可能停在別張單的分支，不要看工作目錄的檔案。'].join('\n')
    : '（找不到這張單的專案資料夾，只能根據單的內容寫）';
}

// ---- 1. 寫規格 ----

export const specSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown'],
  properties: { markdown: { type: 'string', description: '整份規格（Markdown）' } },
};

export function buildSpecPrompt(review: Review, settings: Settings): string {
  return [
    `你是 ${review.ticketKey} 的 Elephant：開工前把這張單寫成一份規格（設計文件）。`,
    '之後會由「完全沒看過這張單、也沒看過任何討論」的 AI 審查這份規格、照它開發，做完再拿它比對程式改動，所以規格要自給自足：只看規格就知道要做什麼、改哪裡、怎麼驗收。',
    '',
    '## 規則',
    '- 只能讀，不能改任何檔案。程式碼用 git 讀下面列的遠端基底分支。',
    '- 這是前端的工作，後端由別的團隊做。規格裡的 API、欄位、狀態值只能寫「單上寫的」或「程式碼裡確認存在的」，並標出處（單號，或檔案路徑）。兩邊都找不到的，不准自己設計（不要發明 API、欄位、錯誤碼、版本號、冪等鍵這類東西），寫進「待確認問題」。',
    '- 提到的既有檔案、函式、元件都要實際確認存在，寫出路徑；要新增的標明「新增」。',
    '- 產品上有不只一種合理做法、單上沒寫、程式碼也推不出來的，寫進「待確認問題」並附建議答案，不要自己挑。純技術上只有一種合理做法的自己決定，寫下理由。',
    '- 多商戶的專案：每個要做的商戶都要確認程式結構一不一樣，不一樣就分開寫。FlowPilot 會先在來源商戶開發、測完，其他商戶之後才各自移植（另外的工作），所以「要改的檔案」和「驗收項目」要標清楚屬於哪個商戶。',
    '- 不要寫程式碼。不要寫自動化測試計畫、測試覆蓋率、監控、效能數字、上線計畫（團隊流程不需要）。驗收以畫面上可以操作驗證的為主。',
    '- 給人看的文字用繁體中文（台灣）寫，白話、具體；檔名、函式名、程式碼保留原文。',
    '',
    '## 格式（Markdown，照順序這些段落）',
    '1. 概要：要解決什麼問題，兩三句。',
    '2. 目標',
    '3. 不做的事：範圍外、容易被誤做的。',
    '4. 待確認問題：每題附建議答案；沒有就寫「沒有」。',
    '5. 使用情境：每個寫「前提／動作／預期結果」，要涵蓋每個商戶、每個頁面入口、空資料、錯誤、權限、載入中、邊界值。',
    '6. 做法：改哪裡、資料從哪裡來（出處）、判斷條件寫清楚、為什麼這樣做；考慮過的其他做法一兩句。',
    '7. 要改的檔案：每個標「新增」或「修改」，寫要改什麼。',
    '8. 驗收項目：逐條、可以在畫面上驗證；Jira 的預期結果每一條都要涵蓋。',
    '',
    '## 需求分析（開工前審閱的結果，含已確認的疑問）',
    reviewBrief(review),
    '',
    '## Jira 原文',
    ticketText(review),
    '',
    '## 程式碼在哪裡',
    locationText(review, settings),
  ].join('\n');
}

// ---- 2. 沒看過的 AI 審查 ----

export const reviewerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'scope', 'text'],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          scope: { type: 'string', description: 'Affected section, file or symbol' },
          text: { type: 'string', description: 'The finding and the recommendation' },
        },
      },
    },
  },
};

/** 審查角色的完整提示：EGM 原文角色、評分標準，加上 FlowPilot 的任務說明（衝突時以任務說明為準） */
export function buildReviewerPrompt(reviewer: (typeof SPEC_REVIEWERS)[number], spec: string, locations: string): string {
  return [
    reviewer.persona,
    '',
    '---',
    '# Target Standard',
    reviewer.standard,
    '',
    '---',
    '# Task from the orchestrator',
    '',
    'Mode: REVIEW',
    'Target document: the specification below (the full document).',
    'Codebase context (read-only; use git on the listed remote base branches, never the working tree):',
    locations,
    '',
    'FlowPilot context (overrides the persona and the standard where they conflict):',
    '- This is a frontend task from a Jira ticket in a team project. The backend is owned by another team. The spec must not invent backend APIs, fields, status values or error codes: anything it presents as existing (API, field, file, function) that you cannot find in the code, and that it does not attribute to the ticket, is a Blocker — say it is invented.',
    '- Do not ask for automated test files, coverage targets, telemetry, monitoring, performance numbers or rollout plans. The team does not use them.',
    '- Focus on what will make the implementation wrong: decisions left to the implementer, missing scenarios (each merchant, each page entry, empty / error / permission / loading states, boundaries), wrong assumptions about existing code, simpler reuse of existing code.',
    '- At most 8 findings, most severe first. Leave out style nits unless they would cause wrong behavior.',
    '- Write the findings in Traditional Chinese (Taiwan). Keep file paths, symbols and code as they are.',
    '',
    '---',
    '# Specification',
    spec,
  ].join('\n');
}

// ---- 3. 處理意見 ----

export const resolveSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'questions', 'markdown'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['no', 'decision', 'note'],
        properties: {
          no: { type: 'number' },
          decision: { type: 'string', enum: ['fix', 'contest', 'ask'] },
          note: { type: 'string', description: zhOnly('照改：怎麼改；反駁：可查證的證據；問：問題是哪一題') },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'suggestion'],
        properties: {
          title: { type: 'string', description: zhOnly('一句白話的問題（操作者不是工程師）') },
          detail: { type: 'string', description: zhOnly('為什麼要問：答案會影響什麼') },
          suggestion: { type: 'string', description: '你建議的答案' },
        },
      },
    },
    markdown: { type: 'string', description: '修正後的整份規格' },
  },
};

export function buildResolvePrompt(findings: { role: string; severity: string; text: string }[]): string {
  return [
    '## 審查意見',
    '沒有背景的審查者看過你寫的規格，提出下面的意見。逐條處理：',
    '- fix（照改）：意見對，修改規格。',
    '- contest（反駁）：意見不對或不需要。note 寫可以查證的證據（檔案與函式，或單上原文）。',
    '- ask（問操作者）：只有「產品上要怎麼做」、單上沒寫、程式碼也推不出來的才放這類。操作者不是工程師，不要問技術選擇（技術上的自己決定）。',
    '- 要求寫自動化測試、測試覆蓋率、監控、效能數字、上線計畫的，一律 contest（團隊不需要）。',
    '- 指出規格發明了不存在的 API、欄位的：一律 fix，改成寫進「待確認問題」或照程式碼實際有的寫。',
    '- 重複的意見一起處理。',
    '',
    '回傳：',
    '- items：每一條意見的處理（no 用下面的編號）。',
    '- questions：要問操作者的問題，合併重複的，最多 5 個；沒有就給空陣列。之前「需求分析」裡已經確認過的不要再問。',
    '- markdown：修正後的整份規格（要問的寫在「待確認問題」，附建議答案）。',
    '',
    ...findings.map((f, i) => `${i + 1}. [${f.role}｜${f.severity}] ${f.text}`),
  ].join('\n');
}

// ---- 整個開工前的流程 ----

export interface SpecDeps {
  codex: CodexRpc;
  settings: () => Settings;
  /** 審閱對話用的工作目錄（FlowPilot 的資料位置） */
  cwd: string;
  /** 讀最新的審閱結果、改完存回去（回傳 null 就不存） */
  updateReview(ticketKey: string, change: (review: Review) => Review | null): Review | null;
  log(message: string): void;
}

/**
 * 寫規格 → 沒看過的 AI 審查 → 處理意見。做完存進審閱結果（要問你的放進問題清單）。
 * 中途重新審閱過（審閱結果換了），這次的結果就不存。
 */
export async function generateSpec(deps: SpecDeps, ticketKey: string): Promise<void> {
  const now = () => new Date().toISOString();
  let reviewedAt = '';
  const save = (patch: Partial<Spec>, extra?: (review: Review) => Review) =>
    deps.updateReview(ticketKey, (review) => {
      if (reviewedAt && review.reviewedAt !== reviewedAt) return null;
      const next: Review = { ...review, spec: { ...emptySpec(review.reviewedAt), ...review.spec, ...patch, at: now() } };
      return extra ? extra(next) : next;
    });
  const start = deps.updateReview(ticketKey, (review) => ({ ...review, spec: { ...emptySpec(review.reviewedAt), step: zhOnly('寫規格'), at: now() } }));
  if (!start) return;
  reviewedAt = start.reviewedAt;
  const settings = deps.settings();
  try {
    // 1. 寫規格：保留對話，處理意見時接著問（寫的 AI 記得自己為什麼這樣寫）
    const written = await runStructured<{ markdown: string }>(deps.codex, {
      cwd: deps.cwd,
      keep: true,
      effort: 'medium',
      prompt: buildSpecPrompt(start, settings),
      schema: specSchema,
      timeoutMs: 15 * 60_000,
    });
    const draft = String(written.result.markdown ?? '').trim();
    if (!draft) throw new Error(t('AI 沒有寫出規格'));
    if (!save({ step: zhOnly('審查'), markdown: draft })) return;

    // 2. 四個角色各開一段全新的唯讀對話，同時審；看不到單、需求分析和寫規格的對話
    const locations = locationText(start, settings);
    const results = await Promise.allSettled(
      SPEC_REVIEWERS.map((reviewer) =>
        runStructured<{ findings: { severity: string; scope: string; text: string }[] }>(deps.codex, {
          cwd: deps.cwd,
          effort: 'medium',
          prompt: buildReviewerPrompt(reviewer, draft, locations),
          schema: reviewerSchema,
          timeoutMs: 10 * 60_000,
        }).then(({ result }) => (result.findings ?? []).map((f) => ({ role: reviewer.key, severity: SEVERITIES.includes(f.severity as never) ? f.severity : 'Major', text: [f.scope, f.text].filter(Boolean).join('：') }))),
      ),
    );
    const failedReviewers = results.filter((r) => r.status === 'rejected').length;
    results.forEach((r, i) => r.status === 'rejected' && deps.log(`${ticketKey} 規格審查「${SPEC_REVIEWERS[i].key}」失敗：${(r.reason as Error)?.message}`));
    if (failedReviewers === SPEC_REVIEWERS.length) throw new Error(t('四個審查角色都沒有完成'));
    const raw = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!raw.length) {
      save({ status: 'done', step: '', failedReviewers });
      return;
    }
    if (!save({ step: zhOnly('處理意見'), failedReviewers })) return;

    // 3. 回到寫規格的對話處理意見
    const resolved = await runStructured<{ items: { no: number; decision: string; note: string }[]; questions: { title: string; detail: string; suggestion: string }[]; markdown: string }>(deps.codex, {
      cwd: deps.cwd,
      threadId: written.threadId,
      effort: 'medium',
      prompt: buildResolvePrompt(raw),
      schema: resolveSchema,
      timeoutMs: 12 * 60_000,
    });
    const findings: SpecFinding[] = raw.map((f, i) => {
      const hit = resolved.result.items?.find((x) => Number(x.no) === i + 1);
      const decision = hit && ['fix', 'contest', 'ask'].includes(hit.decision) ? (hit.decision as SpecFinding['decision']) : 'fix';
      return { role: f.role, severity: f.severity as SpecFinding['severity'], text: f.text, decision, note: String(hit?.note ?? '').trim() };
    });
    const markdown = String(resolved.result.markdown ?? '').trim() || draft;
    const questions = (resolved.result.questions ?? []).filter((q) => q?.title).slice(0, 5);
    save({ status: 'done', step: '', markdown, findings, failedReviewers }, (review) => withSpecQuestions(review, questions));
  } catch (error) {
    deps.log(`${ticketKey} 規格流程失敗：${(error as Error).message}`);
    save({ status: 'failed', step: '', error: (error as Error).message });
  }
}

function emptySpec(reviewedAt: string): Spec {
  return { status: 'running', step: '', markdown: '', findings: [], failedReviewers: 0, reviewedAt, at: new Date().toISOString() };
}

/**
 * 這張單的規格接下來要怎樣：start 開始寫、wait 等正在寫的那個、none 不用動。
 * - 不走規格流程、或這次審閱的規格已經寫好或失敗了（失敗要你按重試，force）：不用動
 * - 正在寫的是這次審閱的：等它（不重複開始）
 * - 還沒寫、寫的是舊審閱的、或寫到一半 FlowPilot 重新啟動過（存著「寫規格中」卻沒在寫）：開始寫
 */
export function specNextStep(review: Review, runningFor: string | null, force = false): 'start' | 'wait' | 'none' {
  if (!wantsSpec(review)) return 'none';
  if (runningFor === review.reviewedAt) return 'wait';
  const current = review.spec?.reviewedAt === review.reviewedAt;
  if (!force && current && review.spec?.status !== 'running') return 'none';
  return 'start';
}

let nextId = 0;

/** 要問你的問題放進審閱的問題清單：上一版規格問的、你還沒處理的拿掉，處理過的留著；同樣的問題不重複 */
export function withSpecQuestions(review: Review, questions: { title: string; detail: string; suggestion: string }[]): Review {
  const issues = review.issues.filter((i) => !(i.fromSpec && i.status === 'open'));
  for (const q of questions) {
    const title = String(q.title).trim();
    if (!title || issues.some((i) => i.title === title)) continue;
    const issue: ReviewIssue = {
      id: `s${Date.now().toString(36)}${(nextId++).toString(36)}`,
      type: '需求不明確',
      importance: '重要',
      title,
      detail: String(q.detail ?? '').trim(),
      quote: zhOnly('單上沒有提到'),
      from: review.ticketKey,
      suggestion: String(q.suggestion ?? '').trim(),
      status: 'open',
      fromSpec: true,
    };
    issues.push(issue);
  }
  return { ...review, issues };
}

/** 給開發的 AI：照規格做（附在需求分析後面） */
export function specBrief(review: Review | null): string {
  if (!review?.spec || review.spec.status !== 'done' || !review.spec.markdown) return '';
  return [
    '',
    '## 規格（開工前寫好、由沒看過的 AI 審查過；照這份做）',
    '- 規格的「待確認問題」：以上面需求分析「疑問」段的答案為準；還沒確認的照建議答案做，並在回覆中標示是暫定的。',
    '- 規格跟 Jira 原文衝突時以 Jira 為準，並在回覆中說明。',
    '- 做完 FlowPilot 會請另一個沒看過開發過程的 AI 拿這份規格比對你的改動。',
    '',
    review.spec.markdown,
  ].join('\n');
}

// ---- 4. 做完後比對 ----

export const specCheckSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'verdict'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'severity', 'text', 'evidence'],
        properties: {
          kind: { type: 'string', enum: ['wrong', 'unsure'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          text: { type: 'string', description: '一句白話，寫給不看程式碼的操作者' },
          evidence: { type: 'string', description: '規格哪一段＋改動的檔案與行' },
        },
      },
    },
    verdict: { type: 'string', description: '一句話：照目前的改動，規格的驗收項目能不能全部通過' },
  },
};

/** 你在審閱時回答過、或照建議的問題（規格的待確認問題以這些為準） */
function answers(review: Review): string {
  const done = review.issues.filter((i) => i.status === 'answered' || i.status === 'assumed');
  return done.length ? done.map((i) => `- ${i.title} → ${i.status === 'answered' ? i.answer : `${zhOnly('照建議：')}${i.suggestion}`}`).join('\n') : '（沒有）';
}

/** 這次比對的範圍：多商戶的單這次只做來源商戶，其他商戶之後才移植 */
export interface SpecCheckScope {
  merchant: number | null;
  /** 之後才移植的商戶 */
  later: number[];
}

/** 多商戶的單只比對這次做的商戶（實際發生過：拿全部商戶的規格比對 M1 這一次，報「其他商戶都還沒有入口」） */
function scopeLines(scope: SpecCheckScope): string[] {
  if (!scope.merchant) return [];
  return [
    `- 範圍：這次只做商戶 m${scope.merchant}（來源商戶，先開發、測完）。` +
      (scope.later.length ? `商戶 ${scope.later.map((m) => `m${m}`).join('、')} 之後才各自移植（另外的工作），規格裡只屬於那些商戶的部分、或「每個商戶都要有」這類要求在其他商戶還沒做到的，都不要報。` : '規格裡屬於其他商戶的部分不要報。'),
  ];
}

export function buildSpecCheckPrompt(review: Review, baseBranch: string, environmentFile: string, scope: SpecCheckScope = { merchant: null, later: [] }): string {
  return [
    '你是沒有任何背景的檢查者。下面是開工前寫好、審查過的規格，開發的 AI 已經照它做完了。逐條比對規格和實際的程式改動。',
    '',
    ...scopeLines(scope),
    '- 看改動：git diff origin/' + baseBranch + '...HEAD（已提交的）、git diff HEAD（還沒提交的）、git ls-files --others --exclude-standard（新檔案，再讀內容）。只讀不改。',
    `- ${environmentFile} 的改動不用管（測試切環境用的）。`,
    '- 目前資料夾就是這張單的分支，需要時可以讀檔案理解上下文。',
    '- 分兩類：',
    '  - wrong（做錯了）：改動違反規格裡有根據的部分（規格引用了 Jira 原文、操作者的回答、或程式碼裡確實存在的東西），或規格的驗收項目照這個改動會失敗、規格要做的沒做。',
    '  - unsure（不確定誰對）：改動跟規格不一樣，但規格那段沒有根據（例如規格假設了程式和單上都沒有的 API、欄位），可能是規格寫錯。',
    '- 規格的「待確認問題」以下面「操作者的回答」為準。',
    '- 不要報：沒寫自動化測試、沒加監控、純命名或排版風格、規格沒要求的小重構。',
    '- 每一條：text 一句白話（寫給不看程式碼的操作者），evidence 寫規格哪一段＋改動的檔案與行。最多 12 條，嚴重的在前；沒有問題就給空陣列。',
    '- 給人看的文字用繁體中文（台灣）。',
    '',
    '## 操作者的回答',
    answers(review),
    '',
    '## 規格',
    review.spec?.markdown ?? '',
  ].join('\n');
}

export async function checkAgainstSpec(rpc: CodexRpc, cwd: string, review: Review, baseBranch: string, environmentFile: string, scope?: SpecCheckScope): Promise<SpecCheck> {
  const { result } = await runStructured<{ items: { kind: string; severity: string; text: string; evidence: string }[]; verdict: string }>(rpc, {
    cwd,
    effort: 'medium',
    prompt: buildSpecCheckPrompt(review, baseBranch, environmentFile, scope),
    schema: specCheckSchema,
    timeoutMs: 12 * 60_000,
  });
  const items: SpecCheckItem[] = (result.items ?? [])
    .filter((x) => x?.text)
    .slice(0, 12)
    .map((x, i) => ({
      no: i + 1,
      kind: x.kind === 'unsure' ? 'unsure' : 'wrong',
      severity: (['high', 'medium', 'low'].includes(x.severity) ? x.severity : 'medium') as SpecCheckItem['severity'],
      text: String(x.text).trim(),
      evidence: String(x.evidence ?? '').trim(),
      status: 'open',
    }));
  return { status: 'done', items, verdict: String(result.verdict ?? '').trim(), at: new Date().toISOString() };
}

/** 做錯的交給開發的 AI：逐條確認，真的錯就修，認為規格錯了就說明；最後附處理結果 */
export function buildSpecFixPrompt(items: SpecCheckItem[], environmentFile: string): string {
  return [
    '## 規格比對',
    '',
    '另一個沒看過開發過程的 AI 拿開工前的規格比對了你的改動，認為下面幾點做錯了。逐條確認：',
    '- 真的做錯了就修正。',
    '- 你認為規格寫錯了、或其實已經做到了：不要改，說明理由並附證據（檔案與行、Jira 原文）。',
    '',
    ...items.map((i) => `${i.no}. ${i.text}（${zhOnly('證據')}：${i.evidence || zhOnly('沒有附')}）`),
    '',
    `- 不要提交、不要推送，不要修改 ${environmentFile}。自己做，不要開子 AI（spawn_agent）分工。`,
    '- 改完跑一次跟提交時一樣的 lint，只檢查改到的檔案，不要加 --fix。',
    '- 回覆最後附上每一條的處理結果（FlowPilot 會讀；JSON 要合法）：status 寫 fixed（修好了）或 kept（不改），note 一句話說改了什麼、或為什麼不改。',
    '```flowpilot-spec',
    '[{"no":1,"status":"fixed","note":"…"},{"no":2,"status":"kept","note":"…"}]',
    '```',
  ].join('\n');
}

/** 讀開發的 AI 回覆裡的處理結果，更新比對的每一條；沒附就維持原狀 */
export function applySpecReplies(check: SpecCheck, message: string): SpecCheck {
  const block = /```flowpilot-spec\s*([\s\S]*?)```/.exec(message)?.[1];
  if (!block) return check;
  let replies: { no: number; status: string; note: string }[] = [];
  try {
    const parsed = JSON.parse(block);
    replies = Array.isArray(parsed) ? parsed : [];
  } catch {
    return check;
  }
  return {
    ...check,
    items: check.items.map((item) => {
      const hit = replies.find((r) => Number(r?.no) === item.no);
      if (!hit || item.kind !== 'wrong') return item;
      return { ...item, status: hit.status === 'kept' ? 'kept' : 'fixed', reply: String(hit.note ?? '').trim() };
    }),
  };
}
