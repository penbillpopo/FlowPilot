// 應用程式主程序：選單列圖示＋主視窗。關掉視窗不會結束，背景繼續跑；從選單列「結束」才真的關掉。
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { groupTicket } from '../shared/group';
import { acceptanceCsv } from './acceptance-csv';
import { openInChrome } from './shared-browser';
import { confluencePageId, loadConfluence } from './confluence';
import { AzureRepo, defaultPrTitle, pickReviewers, prDescription, prIdFromUrl } from './azure';
import type { Env, JiraTicket, PrMergeCheck, PrOptions, PrRecord, SupplementItem, WorkItem, Judgement, PlanOptions, Review, ReviewChecks, ReviewIssue, TicketMark, TicketPlan, TicketSnapshot } from '../shared/types';
import { latestPrs, wantsSpec } from '../shared/types';
import { CodexRpc } from './codex/rpc';
import { listSkills, runStructured } from './codex/structured';
import { checkExisting, localBranchExists, remoteBranchExists, runGit } from './git';
import { buildJql, downloadAttachment, getIssueContext, getTransitions, loadCredentials, searchTickets, statusIdsByName, transitionIssue } from './jira';
import { applyDiscussion, buildCodeCheckPrompt, buildDiscussionPrompt, buildFigmaPrompt, buildGroupReviewPrompt, buildReviewPrompt, discussionSchema, REVIEW_INSTRUCTIONS, reviewSchema, sanitizeReview } from './planner/review';
import { deriveBranches, planProblem } from './planner/rules';
import { loadHistory } from './chat';
import { generateReport } from './report';
import { estimateTicket, fillOriginalEstimate } from './estimate';
import { installCommand, missingPackages } from './packages';
import { generateSpec, specNextStep } from './planner/spec';
import { type AiMergeResult, mergeSchema, resolvePrConflict } from './pr-conflict';
import { reviewBrief } from './planner/review';
import { getLang, type Lang, setLang, t, zhOnly } from '../shared/i18n';
import { FolderTerminals } from './folderterminals';
import { branchCommits, commitAll, commitDiff, commitFiles, commitStaged, discard, fileDiff, gitState, pushBranch, stage, unstage } from './gitpanel';
import { diffSnapshots, updateMessage } from './requirements';
import { HANDOFF_PROMPT_TITLE, HEADLESS_BROWSER_NAME, Runner, threadConfig } from './runner/runner';
import { VSCode } from './vscode';
import { loadSettings } from './settings';
import { Store } from './store';

// 從 Finder／Dock 打開時只有最基本的 PATH（找不到 nvm 的 node、npx，Homebrew 的 git）：
// 啟動時讀一次登入 shell 的 PATH，git、Codex、Codex 啟動的瀏覽器工具才都找得到
if (app.isPackaged) {
  try {
    const path = execFileSync(process.env.SHELL || '/bin/zsh', ['-l', '-c', 'printf %s "$PATH"'], { timeout: 10_000, encoding: 'utf8' }).trim();
    if (path) process.env.PATH = path;
  } catch {}
}

// 測試時可以用 FLOWPILOT_DATA_DIR 指定另一個資料位置，不碰到正式的設定與資料庫
const dataDir = process.env.FLOWPILOT_DATA_DIR || join(app.getPath('appData'), 'FlowPilot');
if (process.env.FLOWPILOT_DATA_DIR) app.setPath('userData', join(dataDir, 'electron'));
// 用測試資料位置時預設只能看畫面：不排程、不建分支、不啟動 AI、不做每日檢查（要真的執行得另外加 FLOWPILOT_ALLOW_RUN=1）
const paused = !!process.env.FLOWPILOT_DATA_DIR && !process.env.FLOWPILOT_ALLOW_RUN;
const settingsFile = join(dataDir, '設定.yaml');

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Store;
let runner: Runner;
let quitting = false;
/** AI 判斷用：自己啟動的 Codex，臨時對話 */
const codex = new CodexRpc();
/** 開發用：連到共用常駐服務，VS Code 終端機才接得上同一段對話 */
const daemon = new CodexRpc('daemon');

function log(message: string) {
  try {
    appendFileSync(join(dataDir, 'flowpilot.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

// 狀態有變化時推給畫面（合併 200 毫秒內的多次變化）
let boardTimer: NodeJS.Timeout | null = null;
function boardChanged() {
  if (boardTimer) return;
  boardTimer = setTimeout(() => {
    boardTimer = null;
    window?.webContents.send('board:changed', runner.board());
  }, 200);
}

// AI 正在寫的回覆：每 100 毫秒把各張單的最新內容送一次畫面
const pendingStreams = new Map<number, string>();
let streamTimer: NodeJS.Timeout | null = null;
function streamChanged(itemId: number, text: string) {
  pendingStreams.set(itemId, text);
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    for (const [id, value] of pendingStreams) window?.webContents.send('board:stream', id, value);
    pendingStreams.clear();
  }, 100);
}

// 聊天的即時更新：每 50 毫秒送一批，避免 AI 打字時一個字送一次
const chatQueue: [number, unknown][] = [];
let chatTimer: NodeJS.Timeout | null = null;
function chatChanged(itemId: number, event: unknown) {
  chatQueue.push([itemId, event]);
  if (chatTimer) return;
  chatTimer = setTimeout(() => {
    chatTimer = null;
    window?.webContents.send('chat:events', chatQueue.splice(0));
  }, 50);
}

const folderTerminals = new FolderTerminals((channel, ...args) => window?.webContents.send(channel, ...args), (m) => log(m));

function startCommand(command: string | undefined, port: number | undefined) {
  return (command ?? 'npm start').replaceAll('{port}', String(port ?? 4200));
}

/** 這張單所在的資料夾 */
function folderOf(itemId: number) {
  const item = store.getWorkItem(itemId);
  if (!item?.folder) throw new Error(t('這張單還沒有分配資料夾'));
  const settings = loadSettings(settingsFile);
  const folder = settings.folders.find((f) => f.name === item.folder);
  if (!folder) throw new Error(t('設定檔裡沒有資料夾「{folder}」', { folder: item.folder }));
  return { item, folder, rule: settings.projects[folder.project] };
}

/**
 * 讀這張單分支的地方（只讀，不切換）：自己的資料夾優先，再找同專案其他有這條本機分支的資料夾，
 * 都沒有就讀遠端的分支。待補測、已完成的單沒有資料夾也看得到提交。
 */
async function branchSource(itemId: number): Promise<{ cwd: string; ref: string; where: string; branch: string; base: string }> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error(t('找不到這張單'));
  const folders = loadSettings(settingsFile).folders.filter((f) => f.project === item.project);
  if (!folders.length) throw new Error(t('設定檔裡沒有「{project}」的資料夾', { project: item.project }));
  const ordered = [...folders.filter((f) => f.name === item.folder), ...folders.filter((f) => f.name !== item.folder)];
  const at = { branch: item.branch, base: item.baseBranch };
  for (const f of ordered) if (await localBranchExists(f.path, item.branch).catch(() => false)) return { cwd: f.path, ref: item.branch, where: f.name, ...at };
  if (await remoteBranchExists(folders[0].path, item.branch).catch(() => false)) return { cwd: folders[0].path, ref: `origin/${item.branch}`, where: '遠端', ...at };
  throw new Error(t('找不到 {branch}：本機的資料夾和遠端都沒有', { branch: item.branch }));
}

/** 正在產生分析報告的單 */
const reportsRunning = new Set<number>();

function notify(title: string, body: string, itemId: number) {
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    showWindow();
    window?.webContents.send('board:focus', itemId);
  });
  notification.show();
}

/** 同時最多幾個 AI 判斷在跑 */
const JUDGE_CONCURRENCY = 3;
let judging = 0;
const judgeQueue: (() => void)[] = [];
async function withJudgeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (judging >= JUDGE_CONCURRENCY) await new Promise<void>((resolve) => judgeQueue.push(resolve));
  judging++;
  try {
    return await task();
  } finally {
    judging--;
    judgeQueue.shift()?.();
  }
}

/** 審閱一張單：讀單 → 判斷專案 → 大略看程式碼 → 找問題。已經審過就直接用上次的結果 */
/** 正在審閱的單：同一張單同時只審一次（背景審閱還沒好、你又打開計畫表時，等同一個結果） */
const reviewing = new Map<string, Promise<Review>>();

function reviewTicket(ticket: JiraTicket, force = false): Promise<Review> {
  const saved = store.getReview(ticket.key);
  if (saved && !force) return Promise.resolve(saved.review);
  const running = reviewing.get(ticket.key);
  if (running && !force) return running;
  const job = runReview(ticket).finally(() => {
    if (reviewing.get(ticket.key) === job) reviewing.delete(ticket.key);
  });
  reviewing.set(ticket.key, job);
  return job;
}

async function runReview(ticket: JiraTicket): Promise<Review> {
  const settings = loadSettings(settingsFile);
  const credentials = loadCredentials(settings.jira.envFile);
  // 合成任務：每張成員單都讀，上層主單不重複
  const members = ticket.members?.length ? ticket.members : [ticket];
  const parentKeys = [...new Set(members.map((m) => m.parent?.key).filter((k): k is string => !!k))];
  const [subs, mains] = await Promise.all([
    Promise.all(members.map((m) => getIssueContext(credentials, m.key))),
    Promise.all(parentKeys.map((k) => getIssueContext(credentials, k))),
  ]);
  const sub = subs[0];
  const main = mains[0] ?? null;
  // 圖片附件（需求常畫在截圖裡）：主單在前，最多 5 張、每張 5MB 以內，讀不到就略過
  const images: string[] = [];
  const imageDir = join(dataDir, 'attachments', 'review', ticket.key);
  for (const img of [...mains.flatMap((m) => m.imageAttachments), ...subs.flatMap((x) => x.imageAttachments)].filter((a) => a.size <= 5_000_000).slice(0, 5)) {
    try {
      mkdirSync(imageDir, { recursive: true });
      const dest = join(imageDir, img.filename.replace(/[^\w.\-]+/g, '_'));
      await downloadAttachment(credentials, img.url, dest);
      images.push(dest);
    } catch (error) {
      log(`${ticket.key} 下載圖片 ${img.filename} 失敗：${(error as Error).message}`);
    }
  }
  // 你補充的需求來源：Confluence 讀內容（問題表只取這張單的那幾列和截圖）、文字、截圖
  const supplements: { label: string; text: string }[] = [];
  const supplementImages: string[] = [];
  for (const extra of store.draftExtras(ticket.key)) {
    if (extra.kind === 'text') supplements.push({ label: zhOnly('你補充的說明'), text: extra.value });
    else if (extra.kind === 'image') {
      if (existsSync(extra.value)) supplementImages.push(extra.value);
    } else if (confluencePageId(extra.value)) {
      try {
        const page = await loadConfluence(credentials, extra.value, members.map((m) => m.summary), imageDir);
        supplements.push({ label: page.label, text: page.text });
        supplementImages.push(...page.images);
      } catch (error) {
        supplements.push({ label: extra.value, text: `（讀不到：${(error as Error).message}）` });
      }
    } else {
      supplements.push({ label: extra.value, text: '（不是 Confluence 頁面，FlowPilot 讀不到內容；需要的話把內容貼成文字）' });
    }
  }
  // 補充的截圖排前面（你特地補的，比單上的附件重要），最多 8 張
  images.splice(0, images.length, ...[...supplementImages, ...images].slice(0, 8));
  const supplementPrompt = supplements.length
    ? `\n\n## 補充資料（使用者另外提供的需求來源，跟 Jira 單一樣重要；跟單上的內容衝突時列成問題）\n${supplements.map((x) => `\n【${x.label}】\n${x.text}`).join('\n')}`
    : '';
  // 審閱要用 git 讀各商戶的遠端基底分支（審閱的對話是唯讀的，自己不能抓），先抓一次，看到的才是最新的
  await Promise.all(settings.folders.map((f) => runGit(f.path, ['fetch', 'origin', '--quiet'], 60_000).catch(() => null)));
  const { result, threadId } = await withJudgeSlot(() =>
    runStructured<any>(codex, {
      cwd: dataDir,
      keep: true, // 保留對話，之後可以接著討論
      developerInstructions: REVIEW_INSTRUCTIONS,
      images,
      prompt: (ticket.members?.length ? buildGroupReviewPrompt(ticket, subs, mains, settings, store.recentDecisions()) : buildReviewPrompt(ticket, sub, main, settings, store.recentDecisions())) + supplementPrompt + (images.length ? `\n\n（附上單上的 ${images.length} 張圖片）` : ''),
      schema: reviewSchema(settings),
      timeoutMs: 300_000,
    }),
  );
  let review = sanitizeReview(result, ticket, settings);
  // 一般、複雜的單一定要大略看過程式碼：AI 第一輪沒看，就在同一段對話追加一輪，指定專案資料夾
  const codePrompt = review.level !== '小' && !review.codeChecked ? buildCodeCheckPrompt(review.entries, settings) : null;
  if (codePrompt) {
    try {
      const checked = await withJudgeSlot(() =>
        runStructured<any>(codex, { cwd: dataDir, keep: true, threadId, developerInstructions: REVIEW_INSTRUCTIONS, prompt: codePrompt, schema: reviewSchema(settings), timeoutMs: 300_000 }),
      );
      // 照 AI 實際回報的：之前寫死成「有看過程式碼」，AI 沒看也顯示有看，錯誤更難發現
      review = sanitizeReview(checked.result, ticket, settings);
    } catch (error) {
      log(`${ticket.key} 看程式碼失敗，先用只看單的結果：${(error as Error).message}`);
    }
  }
  // 參考資料直接從 Jira 擷取（主單在前），不經過 AI；同一個網址只留一筆
  const seen = new Set<string>();
  const resources = [...mains.flatMap((m) => m.resources), ...subs.flatMap((x) => x.resources)].filter((r) => !seen.has(r.url) && seen.add(r.url));
  // 檢查計畫要對照 Figma、單上也有 Figma 連結：追加一輪，用 Figma 工具看設計稿（只看流程與描述）
  const figmaUrls = resources.filter((r) => r.kind === 'figma').map((r) => r.url).slice(0, 3);
  if (review.checks?.figma.need && figmaUrls.length) {
    try {
      const figma = await withJudgeSlot(() =>
        runStructured<any>(codex, { cwd: dataDir, keep: true, threadId, developerInstructions: REVIEW_INSTRUCTIONS, prompt: buildFigmaPrompt(figmaUrls), schema: reviewSchema(settings), timeoutMs: 300_000 }),
      );
      review = { ...sanitizeReview(figma.result, ticket, settings), figmaChecked: true };
    } catch (error) {
      log(`${ticket.key} 對照 Figma 失敗，先用沒對照的結果：${(error as Error).message}`);
    }
  }
  review.resources = resources;
  // 存下這次讀到的內容，之後比對 PM 有沒有改單
  review.snapshot = [...subs.map((x) => x.snapshot), ...mains.map((m) => m.snapshot)];
  if (supplements.length) review.supplements = supplements;
  if (supplementImages.length) review.supplementImages = supplementImages;
  // 「開發完自動測試」「規格流程」你改過的：重新審閱時保留你的選擇
  const kept = store.getReview(ticket.key)?.review.checks;
  if (kept?.autotest && review.checks) review.checks = { ...review.checks, autotest: kept.autotest };
  if (kept?.spec && review.checks) review.checks = { ...review.checks, spec: kept.spec };
  store.saveReview(review, threadId);
  // 複雜的單（或你勾了規格流程）：接著在背景寫規格、審查
  if (wantsSpec(review)) void ensureSpec(review.ticketKey);
  return review;
}

// ---- 規格流程（開工前寫規格、沒看過的 AI 審查） ----

/** 正在跑的規格流程：單號 → 根據哪一次審閱、做完的時候 */
const specJobs = new Map<string, { reviewedAt: string; job: Promise<void> }>();

/** 讀最新的審閱結果改一部分再存回（規格流程跑很久，中間你可能回答了問題，不能整份蓋掉） */
function updateReview(ticketKey: string, change: (review: Review) => Review | null): Review | null {
  const saved = store.getReview(ticketKey);
  if (!saved) return null;
  const next = change(saved.review);
  if (next) store.saveReview(next, saved.threadId);
  return next;
}

/**
 * 這張單要走規格流程、而且還沒有這次審閱的規格：開始寫（已經在寫就等同一個）。
 * 寫好、失敗或不用寫都會結束；開工時等它，規格才會交給開發的 AI。
 */
function ensureSpec(ticketKey: string, force = false): Promise<void> {
  const review = store.getReview(ticketKey)?.review;
  if (paused || !review) return Promise.resolve();
  const running = specJobs.get(ticketKey);
  const next = specNextStep(review, running?.reviewedAt ?? null, force);
  if (next === 'wait') return running!.job;
  if (next === 'none') return Promise.resolve();
  const job = generateSpec({ codex, settings: () => loadSettings(settingsFile), cwd: dataDir, updateReview, log }, ticketKey).finally(() => {
    if (specJobs.get(ticketKey)?.job === job) specJobs.delete(ticketKey);
  });
  specJobs.set(ticketKey, { reviewedAt: review.reviewedAt, job });
  return job;
}

// ---- 需求變更 ----

/**
 * 更新需求（你按了才做）：重新讀 Jira，跟上次確認過的內容比對，把結果交給這張單的 AI，
 * AI 在對話裡回答有沒有變更、打算怎麼改；這次讀到的內容變成新的快照。
 */
async function requestRequirementUpdate(itemId: number): Promise<void> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error(t('找不到這張單'));
  if (!item.threadId) throw new Error(t('這張單還沒開始開發，開始之後才能更新需求'));
  const saved = store.getReview(item.ticketKey);
  const keys = saved?.review.snapshot?.map((s) => s.key) ?? [...new Set([item.ticketKey, ...item.members.map((m) => m.key), item.mainKey])];
  const credentials = loadCredentials(loadSettings(settingsFile).jira.envFile);
  const fresh: TicketSnapshot[] = [];
  for (const key of keys) fresh.push((await getIssueContext(credentials, key)).snapshot);
  const changes = saved?.review.snapshot?.length ? diffSnapshots(saved.review.snapshot, fresh, item.ticketKey) : null;
  await runner.reply(itemId, updateMessage(changes, fresh), [], { asFix: false, activity: t('請 AI 比對需求變更') });
  if (saved) {
    store.saveReview({ ...saved.review, snapshot: fresh }, saved.threadId);
    // 有變更時在背景更新審閱的問題清單（變更可能回答了之前沒確認的問題）
    if (changes?.length) {
      const summary = changes.map((c) => `${c.title}：${(c.lines ?? []).map((l) => `${l.type === 'add' ? '+' : '-'}${l.text}`).join(' ')}${c.text ?? ''}`).join('\n');
      discussReview(item.ticketKey, `需求變更了，請依照下面的內容更新問題清單：\n${summary}`).catch((e) => log(`更新 ${item.ticketKey} 的問題清單失敗：${e.message}`));
    }
  }
}

function updateIssue(ticketKey: string, issueId: string, patch: { status: ReviewIssue['status']; answer?: string }): Review {
  const saved = store.getReview(ticketKey);
  if (!saved) throw new Error(t('{key} 還沒有審閱', { key: ticketKey }));
  const review: Review = {
    ...saved.review,
    issues: saved.review.issues.map((i) => (i.id === issueId ? { ...i, status: patch.status, answer: patch.status === 'answered' ? (patch.answer ?? '').trim() : undefined, byDiscussion: undefined } : i)),
  };
  store.saveReview(review, saved.threadId);
  return review;
}

async function discussReview(ticketKey: string, text: string, images: string[] = []): Promise<Review> {
  const saved = store.getReview(ticketKey);
  if (!saved) throw new Error(t('{key} 還沒有審閱', { key: ticketKey }));
  const pictures = images.filter((p) => existsSync(p)).slice(0, 8);
  if (!text.trim() && !pictures.length) throw new Error(t('訊息是空的'));
  // 附圖：文字補一句，討論紀錄也記下附了幾張
  const said = `${text.trim()}${pictures.length ? `${text.trim() ? '\n' : ''}${t('（附上 {count} 張圖）', { count: pictures.length })}` : ''}`;
  const request = { cwd: dataDir, keep: true, developerInstructions: REVIEW_INSTRUCTIONS, schema: discussionSchema, prompt: buildDiscussionPrompt(saved.review, said), images: pictures, timeoutMs: 300_000 };
  // 接著審閱時的對話討論（AI 記得單和程式碼）；對話不在了就開一段新的
  const { result, threadId } = await runStructured<any>(codex, { ...request, threadId: saved.threadId ?? undefined }).catch(() => runStructured<any>(codex, request));
  const review = applyDiscussion(saved.review, said, result);
  store.saveReview(review, threadId);
  return review;
}

/**
 * 關掉瀏覽器測試開出來的瀏覽器：只找 FlowPilot 提供的瀏覽器工具（輸出位置在 FlowPilot 資料夾）底下開的，
 * 你自己開的 Chrome 不會被關。回傳關掉幾個。
 */
function closeTestBrowsers(): number {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const tools = new Set(rows.filter((r) => r.command.includes(join(dataDir, '瀏覽器測試紀錄'))).map((r) => r.pid));
  const browsers = rows.filter((r) => tools.has(r.ppid) && /chrom/i.test(r.command));
  for (const b of browsers) {
    try {
      process.kill(b.pid);
    } catch {}
  }
  return browsers.length;
}

/**
 * 試登一次：開一段獨立的臨時對話（不弄亂這張單的開發對話），用無頭瀏覽器照帳號檔登入看看。
 * 瀏覽器一樣套上寫入防護。
 */
async function trialLogin(itemId: number): Promise<{ ok: boolean; reason: string }> {
  const { url, env, accountFile, username, hosts } = await runner.prepareTrialLogin(itemId);
  const browser = threadConfig(dataDir, writeGuardPath(), itemId, hosts).mcp_servers[HEADLESS_BROWSER_NAME];
  const { result } = await runStructured<{ ok: boolean; reason: string }>(codex, {
    cwd: dataDir,
    timeoutMs: 240_000,
    config: { mcp_servers: { [HEADLESS_BROWSER_NAME]: browser } },
    schema: { type: 'object', additionalProperties: false, required: ['ok', 'reason'], properties: { ok: { type: 'boolean' }, reason: { type: 'string', description: zhOnly('繁體中文一句話：成功就寫登入後看到什麼；失敗寫原因') } } },
    prompt: [
      `只做一件事：用 ${HEADLESS_BROWSER_NAME} 這個瀏覽器工具打開 ${url}，登入看看。`,
      `帳號密碼用終端機讀 ${accountFile}（例如 cat），登入畫面要 OTP 就填檔案裡的 otp。不要把密碼寫進回覆。`,
      '登入成功（進到登入後的頁面）就回 ok: true；失敗（帳號密碼錯、OTP、被擋、頁面打不開）就回 ok: false 並寫原因。不要做其他操作。',
    ].join('\n'),
  });
  log(`試登 ${env.toUpperCase()}（${username}）：${result.ok ? '成功' : '失敗'}：${result.reason}`);
  return result;
}

/** 這張單的專案資料夾（用來讀遠端網址和 git 憑證；已完成的單資料夾可能在做別張，但遠端是同一個） */
function projectFolder(item: WorkItem): string {
  const folders = loadSettings(settingsFile).folders;
  const folder = folders.find((f) => f.name === item.folder) ?? folders.find((f) => f.project === item.project);
  if (!folder) throw new Error(t('設定檔裡沒有 {project} 的資料夾', { project: item.project }));
  return folder.path;
}

/** 把 Azure 上還開著的 PR 補進這張單的紀錄（例如在 Azure 網頁上自己發的）；同一個 PR 不重複記 */
function rememberPrs(itemId: number, prs: PrRecord[]) {
  const item = store.getWorkItem(itemId)!;
  // 照原本的順序更新（舊資料沒有目標分支，用 Azure 上的補上），新的接在後面
  const merged = [...item.prs.map((p) => prs.find((x) => x.url === p.url) ?? p), ...prs.filter((x) => !item.prs.some((p) => p.url === x.url))];
  const sameAsBefore = merged.length === item.prs.length && merged.every((p) => item.prs.some((x) => x.url === p.url && x.target === p.target));
  if (!sameAsBefore) {
    store.updateWorkItem(itemId, { prs: merged });
    runner.notifyChanged();
  }
}

/** 讀回這張單發過的 PR 現在的狀態、目標分支、審核人（舊資料只有網址，也一起補齊） */
async function refreshPrs(itemId: number): Promise<void> {
  const item = store.getWorkItem(itemId);
  if (!item?.prs.length) return;
  const repo = await AzureRepo.open(projectFolder(item));
  // 解衝突重發換掉的紀錄（replacedBy）是 FlowPilot 自己記的，Azure 上沒有，要留著
  const fresh = await Promise.all(item.prs.map((p) => repo.getPr(p.id || prIdFromUrl(p.url)).then((x) => (p.replacedBy ? { ...x, replacedBy: p.replacedBy } : x)).catch(() => p)));
  const changed = JSON.stringify(fresh) !== JSON.stringify(item.prs);
  if (changed) {
    store.updateWorkItem(itemId, { prs: fresh });
    runner.notifyChanged();
  }
  // 新出現衝突的 PR：跳通知（同一個 PR 只通知一次，解掉之後又衝突會再通知）
  for (const pr of fresh) {
    const was = item.prs.find((p) => p.url === pr.url)?.conflicts;
    if (pr.conflicts && !was) notify(t('{ticket} 的 PR 有衝突', { ticket: item.ticketKey }), t('發到 {target} 的 PR 跟目標分支有衝突，可以在 PR 那裡按「解衝突重發」', { target: pr.target }), itemId);
  }
}

/**
 * 剛發的 PR：Azure 要一點時間才算出能不能合併（剛發時是「排隊中」），發完後 20 秒、1 分鐘、3 分鐘各看一次。
 * 為什麼：以前只靠每 10 分鐘的檢查，剛好在 PR 發出 12 秒後檢查到「排隊中」，有衝突要再等 10 分鐘才標出來（實際發生過）。
 */
function followUpPrs(itemId: number) {
  for (const delay of [20_000, 60_000, 180_000]) setTimeout(() => void refreshPrs(itemId).catch(() => {}), delay);
}

/**
 * 自動填 Jira 估時（你在 2026-11-09 同意的例外：Jira 除了在單列表切換狀態，只有這一項會自動寫入）。
 * 作戰室裡還沒結束的單，Jira 上沒有估時就照審閱結果填「原始預估值」；已經有值的一律不動。
 * 處理過的單記在 estimated.json，之後不再去問 Jira。審閱還沒好的先跳過，下次再填。
 */
const estimatedFile = join(dataDir, 'estimated.json');
let estimating = false;
async function autoEstimate() {
  if (paused || estimating) return;
  estimating = true;
  try {
    let done: string[] = [];
    try {
      done = JSON.parse(readFileSync(estimatedFile, 'utf8'));
    } catch {}
    const items = store.listWorkItems().filter((i) => i.lane !== 'done' && i.status !== 'removed' && !i.portOf);
    const tickets = [...new Set(items.map((i) => i.ticketKey))];
    let credentials: ReturnType<typeof loadCredentials> | null = null;
    for (const ticketKey of tickets) {
      const own = items.filter((i) => i.ticketKey === ticketKey);
      const keys = own[0].members.length ? own[0].members.map((m) => m.key) : [ticketKey];
      const todo = keys.filter((k) => !done.includes(k));
      if (!todo.length) continue;
      const review = store.getReview(ticketKey)?.review;
      if (!review) continue;
      const extraTargets = own.length - 1 + own.reduce((sum, i) => sum + i.targetMerchants.length, 0);
      const estimate = estimateTicket({ review, extraTargets, members: keys.length });
      credentials ??= loadCredentials(loadSettings(settingsFile).jira.envFile);
      for (const key of todo) {
        try {
          const outcome = await fillOriginalEstimate(credentials, key, estimate.value);
          if (outcome.result === 'written') log(`${key}：Jira 估時填了 ${estimate.value}（${estimate.reason}）`);
          else log(`${key}：Jira 上已經有估時 ${outcome.existing}，不動`);
          done.push(key);
          writeFileSync(estimatedFile, JSON.stringify(done));
        } catch (error) {
          log(`${key}：自動填估時失敗，下次再試：${(error as Error).message}`);
        }
      }
    }
  } catch (error) {
    log(`自動填估時失敗：${(error as Error).message}`);
  } finally {
    estimating = false;
  }
}

/** 每 10 分鐘看一次還在審核中的 PR 有沒有衝突（沒開 VPN 之類的連不上就算了，下次再看） */
async function checkPrConflicts() {
  const items = store.listWorkItems().filter((i) => i.prs.some((p) => p.status !== 'completed' && p.status !== 'abandoned'));
  for (const item of items) await refreshPrs(item.id).catch(() => {});
}

/**
 * 解衝突重發的狀態：PR 編號 → 做到哪一步，或失敗的原因。記在主程序：畫面切走再切回來（重新載入）還看得到，
 * 不會又出現可以再按一次的按鈕（實際發生過）。做完就拿掉。
 */
const prJobs = new Map<number, { itemId: number; text: string; error?: string }>();

/** 解衝突重發：從最新的目標分支開新分支、合併開發分支、AI 解衝突、推送、發新 PR，最後放棄舊的 */
async function resolveConflict(itemId: number, prId: number): Promise<PrRecord> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error(t('找不到這張單'));
  if (prJobs.get(prId)?.text) throw new Error(t('這個 PR 正在處理'));
  const progress = (text: string) => {
    prJobs.set(prId, { itemId, text });
    window?.webContents.send('pr:progress', itemId, prId, text);
  };
  progress(t('準備中'));
  try {
    const repoDir = projectFolder(item);
    const azure = await AzureRepo.open(repoDir);
    const { pr, mode } = await resolvePrConflict(
      {
        repoDir,
        workDir: join(dataDir, '解衝突'),
        azure,
        resolveWithAi: async (cwd, prompt) => (await runStructured<AiMergeResult>(codex, { cwd, writable: true, effort: 'medium', prompt, schema: mergeSchema, timeoutMs: 20 * 60_000 })).result,
        progress,
        log,
      },
      prId,
      { key: item.ticketKey, summary: item.ticketSummary },
    );
    const latest = store.getWorkItem(itemId)!;
    // 同一個 PR 只留一筆：就地更新的換成最新的樣子，被取代的標成放棄
    const kept = latest.prs.filter((p) => p.id !== pr.id || mode === 'self').map((p) => {
      if (p.id !== prId) return p;
      return mode === 'self' ? { ...pr, conflicts: false } : { ...p, status: 'abandoned' as const, conflicts: false, replacedBy: pr.id };
    });
    store.updateWorkItem(itemId, { prs: mode === 'self' ? kept : [...kept, pr] });
    runner.notifyChanged();
    log(
      mode === 'self'
        ? `${item.ticketKey}：PR !${prId} 有衝突，把最新的目標分支合進去解完，PR 就地更新`
        : mode === 'updated'
          ? `${item.ticketKey}：PR !${prId} 有衝突，新內容合進原本的解衝突分支，由 !${pr.id} 帶上，!${prId} 放棄`
          : `${item.ticketKey}：PR !${prId} 有衝突，解完重發成 !${pr.id}`,
    );
    followUpPrs(itemId);
    prJobs.delete(prId);
    window?.webContents.send('pr:progress', itemId, prId, '');
    return pr;
  } catch (error) {
    prJobs.set(prId, { itemId, text: '', error: (error as Error).message });
    window?.webContents.send('pr:progress', itemId, prId, '');
    throw error;
  }
}

/** 審核中、沒有衝突的 PR 能不能在 FlowPilot 完成合併（讀不到的就不列） */
async function mergeChecks(itemId: number): Promise<Record<number, PrMergeCheck>> {
  const item = store.getWorkItem(itemId);
  if (!item) return {};
  const prs = latestPrs(item.prs).filter((p) => p.status === 'active' && !p.conflicts);
  if (!prs.length) return {};
  const repo = await AzureRepo.open(projectFolder(item));
  const prod = loadSettings(settingsFile).projects[item.project]?.prodBranches;
  const result: Record<number, PrMergeCheck> = {};
  for (const p of prs) {
    try {
      result[p.id] = await repo.mergeCheck(p.id, prod);
    } catch {}
  }
  return result;
}

/** 完成合併（在 Azure 上，跟網頁按 Complete merge 一樣）：送出前主程序再檢查一次，正式環境、有選審核人的一律擋下 */
async function completePr(itemId: number, prId: number): Promise<PrRecord> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error(t('找不到這張單'));
  if (prJobs.get(prId)?.text) throw new Error(t('這個 PR 正在處理'));
  const progress = (text: string) => {
    prJobs.set(prId, { itemId, text });
    window?.webContents.send('pr:progress', itemId, prId, text);
  };
  progress(t('準備中'));
  try {
    const repo = await AzureRepo.open(projectFolder(item));
    const record = await repo.completePr(prId, loadSettings(settingsFile).projects[item.project]?.prodBranches, progress);
    const latest = store.getWorkItem(itemId)!;
    store.updateWorkItem(itemId, { prs: latest.prs.map((p) => (p.id === prId ? { ...p, ...record } : p)) });
    runner.notifyChanged();
    log(`${item.ticketKey}：在 FlowPilot 完成合併 PR !${prId}（→ ${record.target}）${record.status === 'completed' ? '' : '，Azure 還在合併'}`);
    prJobs.delete(prId);
    window?.webContents.send('pr:progress', itemId, prId, '');
    return record;
  } catch (error) {
    prJobs.set(prId, { itemId, text: '', error: (error as Error).message });
    window?.webContents.send('pr:progress', itemId, prId, '');
    throw error;
  }
}

async function prOptions(itemId: number): Promise<PrOptions> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error(t('找不到這張單'));
  const repo = await AzureRepo.open(projectFolder(item));
  const settings = loadSettings(settingsFile);
  const [branches, recent, existing, pushed] = await Promise.all([repo.targetBranches(settings.projects[item.project]?.prTargets), repo.recentReviewers(), repo.activePrs(item.branch), repo.branchExists(item.branch)]);
  // 設定檔寫了審核人：只列這些人、預設勾好
  const reviewers = pickReviewers(recent, settings.prReviewers);
  rememberPrs(itemId, existing);
  // 同一張單在其他商戶的工作（多商戶的單：來源商戶和移植出去的），可以一起發 PR
  const others = store.listWorkItems().filter((i) => i.id !== itemId && i.ticketKey === item.ticketKey && i.project === item.project && i.merchant !== null);
  const siblings = await Promise.all(
    others.map(async (i) => ({ id: i.id, merchant: i.merchant!, branch: i.branch, status: i.status, pushed: await repo.branchExists(i.branch).catch(() => false), prs: i.prs })),
  );
  return {
    siblings,
    title: defaultPrTitle(item),
    description: prDescription(item),
    source: item.branch,
    target: branches.includes(item.baseBranch) ? item.baseBranch : branches[0] ?? item.baseBranch,
    branches,
    reviewers,
    fixedReviewers: !!settings.prReviewers?.length,
    existing,
    prodBranches: settings.projects[item.project]?.prodBranches ?? [],
    notPushed: !pushed,
  };
}

/** 一起發的其他商戶：目標分支照這個 PR 的換成那個商戶的（例如 master-1 → master-2）；沒有商戶編號的就用同一個 */
function targetFor(target: string, from: number | null, to: number | null): string {
  if (from === null || to === null) return target;
  const m = target.match(new RegExp(`^(.*?)${from}$`));
  return m ? `${m[1]}${to}` : target;
}

async function createPr(
  itemId: number,
  input: { title: string; description: string; target: string; reviewerIds: string[]; alsoItemIds?: number[] },
): Promise<{ results: { merchant: number | null; target: string; url?: string; error?: string }[] }> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error(t('找不到這張單'));
  if (!input.title.trim()) throw new Error(t('PR 名稱不能空白'));
  const repo = await AzureRepo.open(projectFolder(item));
  // 這張自己用你在表單填的內容；一起發的商戶用各自的說明，名稱共用
  const jobs = [
    { work: item, target: input.target, description: input.description },
    ...(input.alsoItemIds ?? []).map((id) => store.getWorkItem(id)).filter((w): w is NonNullable<typeof w> => !!w && w.ticketKey === item.ticketKey)
      .map((w) => ({ work: w, target: targetFor(input.target, item.merchant, w.merchant), description: prDescription(w) })),
  ];
  const results: { merchant: number | null; target: string; url?: string; error?: string }[] = [];
  for (const job of jobs) {
    const { work, target } = job;
    try {
      if (!(await repo.branchExists(work.branch))) throw new Error(t('遠端還沒有 {branch}，請先推送', { branch: work.branch }));
      // 同一個目標分支已經有開著的 PR 就不重複建立（Azure 也不允許），直接給那個 PR
      const active = await repo.activePrs(work.branch);
      rememberPrs(work.id, active);
      const same = active.find((p) => p.target === target);
      if (same) {
        results.push({ merchant: work.merchant, target, url: same.url, error: t('已經有開著的 PR') });
        continue;
      }
      const pr = await repo.createPr({ source: work.branch, target, title: input.title.trim(), description: job.description, reviewerIds: input.reviewerIds });
      const record = await repo.getPr(pr.id).catch(() => ({ id: pr.id, url: pr.url, target, title: input.title.trim() }));
      store.updateWorkItem(work.id, { prs: [...store.getWorkItem(work.id)!.prs, record] });
      log(`${work.ticketKey}：發了 PR #${pr.id}（${work.branch} → ${target}）`);
      followUpPrs(work.id);
      results.push({ merchant: work.merchant, target, url: pr.url });
    } catch (error) {
      results.push({ merchant: work.merchant, target, error: (error as Error).message });
    }
  }
  runner.notifyChanged();
  return { results };
}

function writeGuardPath() {
  // 打包後放在 app.asar.unpacked（瀏覽器工具是另一個程式，讀不到 asar 裡的檔案）
  return join(app.getAppPath(), 'resources/write-guard.cjs').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

/** 單列表上每張單的標記：在工作台上（進行中的不能再選）、本機已經有這張單的分支（含 -2、-3） */
async function ticketMarks(keys: string[]): Promise<Record<string, TicketMark>> {
  const settings = loadSettings(settingsFile);
  // 每個資料夾的本機分支名稱讀一次就好；分支名稱結尾是單號就算有（例如 ban/ALL-1、ban/m8/ALL-1、ban/ALL-1-2）
  const branches: string[] = [];
  for (const f of settings.folders) {
    const r = await runGit(f.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => null);
    if (r?.code === 0) branches.push(...r.stdout.split('\n').filter(Boolean));
  }
  const marks: Record<string, TicketMark> = {};
  for (const key of keys) {
    const work = store.ticketWorkState(key);
    const ending = new RegExp(`/${key.toUpperCase()}(-\\d+)?$`);
    marks[key] = { active: !!work, done: work === 'done', planning: work !== 'active' && store.isDraft(key), branch: branches.some((b) => ending.test(b.toUpperCase())) };
  }
  return marks;
}

function validatePlans(plans: TicketPlan[]) {
  const settings = loadSettings(settingsFile);
  for (const plan of plans) {
    const problem = planProblem(plan, settings);
    if (problem) throw new Error(t('{key}：{problem}', { key: plan.ticket.key, problem }));
  }
  return settings;
}

function showWindow() {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'FlowPilot',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false },
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on('closed', () => (window = null));
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else window.loadFile(join(__dirname, '../renderer/index.html'));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('FP');
  tray.setToolTip('FlowPilot');
  trayMenu();
}

/** 系統列選單（換語言時重建） */
function trayMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('打開 FlowPilot'), click: showWindow },
      { label: t('打開設定檔'), click: () => shell.openPath(settingsFile) },
      { type: 'separator' },
      { label: t('結束 FlowPilot'), click: () => app.quit() },
    ]),
  );
}

/** 介面語言存在這裡：後端在畫面打開之前就要知道（例如通知） */
const languageFile = join(dataDir, 'language.json');
try {
  setLang(JSON.parse(readFileSync(languageFile, 'utf8')).lang);
} catch {}

function registerIpc() {
  ipcMain.handle('sharedBrowser:reset', (_event, id?: number) => runner.resetSharedBrowser(id));
  ipcMain.handle('lang:set', (_event, lang: Lang) => {
    setLang(lang);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(languageFile, JSON.stringify({ lang: getLang() }));
    trayMenu();
    runner.notifyChanged();
  });
  ipcMain.handle('tickets:list', async (_event, statuses: string[]) => {
    // 每次都重讀設定，改完設定檔不用重開
    const settings = loadSettings(settingsFile);
    const credentials = loadCredentials(settings.jira.envFile);
    return searchTickets(credentials, buildJql(settings.jira.filter, statuses, await statusIdsByName(credentials)));
  });
  // Jira 唯一的寫入：切換狀態（其他一律只讀）
  ipcMain.handle('tickets:transitions', (_event, key: string) => getTransitions(loadCredentials(loadSettings(settingsFile).jira.envFile), key));
  ipcMain.handle('tickets:transition', async (_event, key: string, transitionId: string) => {
    const to = await transitionIssue(loadCredentials(loadSettings(settingsFile).jira.envFile), key, transitionId);
    log(`${key}：Jira 狀態切換成「${to}」`);
    return to;
  });
  ipcMain.handle('tickets:statusOptions', () => {
    const { statuses, defaultStatuses } = loadSettings(settingsFile).jira;
    return { statuses, defaultStatuses };
  });
  ipcMain.handle('pr:options', (_event, id: number) => prOptions(id));
  ipcMain.handle('pr:refresh', (_event, id: number) => refreshPrs(id));
  ipcMain.handle('pr:resolveConflict', (_event, id: number, prId: number) => resolveConflict(id, prId));
  ipcMain.handle('pr:jobs', (_event, id: number) => Object.fromEntries([...prJobs].filter(([, job]) => job.itemId === id).map(([prId, { text, error }]) => [prId, { text, error }])));
  ipcMain.handle('pr:mergeChecks', (_event, id: number) => mergeChecks(id));
  ipcMain.handle('pr:complete', (_event, id: number, prId: number) => completePr(id, prId));
  ipcMain.handle('pr:create', (_event, id: number, input: { title: string; description: string; target: string; reviewerIds: string[] }) => createPr(id, input));
  ipcMain.handle('plan:drafts', () => store.listDrafts());
  ipcMain.handle('plan:add', (_event, tickets: JiraTicket[]) => {
    // 工作台上進行中的單不能再進一次（要等它在工作台移除）；已完成的可以再次開發
    const active = tickets.filter((t) => store.ticketWorkState(t.key) === 'active').map((t) => t.key);
    if (active.length) throw new Error(t('{keys} 已經在工作台上，要在工作台移除後才能再選', { keys: active.join(t('、')) }));
    if (!tickets.length) throw new Error(t('沒有勾選任何單'));
    store.addDrafts(tickets);
    // 審閱在背景跑：你可以先回單列表或去作戰室，回來時結果已經存好。
    // 再次開發的單重新審閱（Jira 上的需求可能變了），不沿用上次的審閱
    for (const ticket of tickets) void reviewTicket(ticket, store.ticketWorkState(ticket.key) === 'done').catch((error) => log(`${ticket.key} 背景審閱失敗：${(error as Error).message}`));
    return store.listDrafts();
  });
  // 好幾張單合成一個任務：計畫表裡變成一張，審閱、分支、對話、PR 都只有一份
  ipcMain.handle('plan:addGroup', (_event, tickets: JiraTicket[]) => {
    const busy = tickets.filter((t) => store.ticketWorkState(t.key) === 'active' || store.isDraft(t.key)).map((t) => t.key);
    if (busy.length) throw new Error(t('{keys} 已經在工作台或計畫表裡了', { keys: busy.join(t('、')) }));
    const group = groupTicket(tickets);
    store.addDrafts([group]);
    void reviewTicket(group).catch((error) => log(`${group.key} 合成任務背景審閱失敗：${(error as Error).message}`));
    return store.listDrafts();
  });
  ipcMain.handle('plan:setExtras', (_event, key: string, extras: SupplementItem[]) => {
    store.saveDraftExtras(key, extras);
    return store.listDrafts();
  });
  ipcMain.handle('plan:saveDraft', (_event, ticketKey: string, plan: TicketPlan) => store.saveDraftPlan(ticketKey, plan));
  // 不做了：從計畫表拿掉，審閱紀錄也刪掉（審閱紀錄跟著計畫表和工作台走）
  ipcMain.handle('plan:discard', (_event, keys: string[]) => {
    store.removeDrafts(keys);
    for (const key of keys) {
      reviewing.delete(key);
      if (!store.hasActiveTicket(key)) store.deleteReview(key);
    }
    return store.listDrafts();
  });
  ipcMain.handle('run:latest', () => store.latestRun());
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error(t('只能打開 https 網址'));
    return shell.openExternal(url);
  });
  ipcMain.handle('settings:open', () => shell.openPath(settingsFile).then(() => undefined));
  ipcMain.handle('i18n:reveal', (_event, id: number) => {
    const file = runner.i18nFile(id);
    if (!file) throw new Error(t('這張單還沒有產生多語系檔'));
    shell.showItemInFolder(file);
  });
  ipcMain.handle('plan:options', (): PlanOptions => {
    const settings = loadSettings(settingsFile);
    return {
      projects: Object.entries(settings.projects).map(([name, rule]) => ({
        name,
        merchants: rule.merchants?.length ? rule.merchants : null,
        side: rule.side ?? '',
        description: rule.description ?? '',
      })),
    };
  });
  ipcMain.handle('skills:list', () => listSkills(codex, loadSettings(settingsFile).folders[0]?.path ?? dataDir));
  ipcMain.handle('review:run', async (_event, ticket: JiraTicket, force: boolean) => {
    const review = await reviewTicket(ticket, force);
    // 該寫規格卻還沒寫的就開始寫：換版前就審閱好的複雜單、規格寫到一半 FlowPilot 重新啟動過。
    // 以前只在審閱完才開始，這些單計畫表會一直顯示「準備寫規格」，其實沒在寫（正在寫的不會重複開始）
    void ensureSpec(ticket.key);
    return store.getReview(ticket.key)?.review ?? review;
  });
  ipcMain.handle('review:setChecks', (_event, ticketKey: string, checks: ReviewChecks) => {
    const saved = store.getReview(ticketKey);
    if (!saved) throw new Error(t('{key} 還沒有審閱', { key: ticketKey }));
    const review = { ...saved.review, checks };
    store.saveReview(review, saved.threadId);
    // 打開規格流程：還沒寫過就開始寫
    if (wantsSpec(review)) void ensureSpec(ticketKey);
    return store.getReview(ticketKey)!.review;
  });
  ipcMain.handle('review:retrySpec', (_event, ticketKey: string) => {
    if (!store.getReview(ticketKey)) throw new Error(t('{key} 還沒有審閱', { key: ticketKey }));
    void ensureSpec(ticketKey, true);
    return store.getReview(ticketKey)!.review;
  });
  ipcMain.handle('review:updateIssue', (_event, ticketKey: string, issueId: string, patch: { status: ReviewIssue['status']; answer?: string }) => updateIssue(ticketKey, issueId, patch));
  ipcMain.handle('review:discuss', (_event, ticketKey: string, text: string, images: string[] = []) => discussReview(ticketKey, text, images));
  ipcMain.handle('req:update', (_event, itemId: number) => requestRequirementUpdate(itemId));
  ipcMain.handle('plan:check', (_event, plans: TicketPlan[], fetch: boolean) => {
    const settings = loadSettings(settingsFile);
    const branches = plans.filter((p) => !planProblem(p, settings)).flatMap((p) => deriveBranches(p, settings));
    return checkExisting(branches, settings.folders, { fetch });
  });
  ipcMain.handle('plan:confirm', async (_event, plans: TicketPlan[], judgements: Record<string, Judgement>) => {
    const settings = validatePlans(plans);
    // 確認前再檢查一次：已存在的分支會切過去繼續開發，但存在於好幾個資料夾時一定要選好用哪一個
    const branches = await checkExisting(plans.flatMap((p) => deriveBranches(p, settings)), settings.folders);
    for (const plan of plans) {
      for (const entry of plan.entries) {
        const local = branches.find((b) => b.ticketKey === plan.ticket.key && b.project === entry.project && b.role !== 'target')?.existsIn.filter((w) => w !== '遠端') ?? [];
        if (local.length > 1 && (!entry.folder || !local.includes(entry.folder))) {
          throw new Error(t('{key}：分支在 {folders} 都有，請選擇要用哪一個資料夾', { key: plan.ticket.key, folders: local.join(t('、')) }));
        }
      }
    }
    // 同名分支已經有了，一定要選好接著做還是開新分支
    const undecided = plans.filter((p) => branches.some((b) => b.ticketKey === p.ticket.key && b.role !== 'target' && b.versions.length && !p.entries.find((e) => e.project === b.project)?.branchSeq));
    if (undecided.length) throw new Error(t('{keys}：已經有同名分支，請選擇接著做還是開新分支', { keys: undecided.map((p) => p.ticket.key).join(t('、')) }));
    const already = plans.filter((p) => store.ticketWorkState(p.ticket.key) === 'active').map((p) => p.ticket.key);
    if (already.length) throw new Error(t('{keys} 已經在工作台上，要等它結束（完成或移除）才能再選', { keys: already.join(t('、')) }));
    // 確認的這幾張自成一批；計畫表裡其他還沒確認的不受影響
    const created = store.createRun(plans.map((p) => p.ticket));
    const run = store.confirmPlan(created.id, plans, judgements);
    store.removeDrafts(plans.map((p) => p.ticket.key));
    // 再次開發：舊的已完成卡片收起來（分支不刪）
    runner.shelveDone(plans.flatMap((p) => [p.ticket.key, ...(p.ticket.members ?? []).map((m) => m.key)]));
    runner.startRun(created.id); // 確認計畫後直接開始：建立分支、分配資料夾、啟動 AI
    void autoEstimate(); // 進作戰室：Jira 上沒有估時的單自動填上
    return run;
  });
  ipcMain.handle('board:get', () => runner.board());
  ipcMain.handle('board:startRun', (_event, runId: number) => runner.startRun(runId));
  ipcMain.handle('item:reply', (_event, id: number, text: string) => runner.reply(id, text));
  ipcMain.handle('item:approve', (_event, id: number, accept: boolean) => runner.approve(id, accept));
  ipcMain.handle('item:decide', (_event, id: number, optionId: string) => runner.decide(id, optionId));
  ipcMain.handle('item:stop', (_event, id: number) => runner.stop(id));
  ipcMain.handle('item:remove', (_event, id: number) => runner.remove(id));
  ipcMain.handle('item:branchInfo', (_event, id: number) => runner.branchInfo(id));
  ipcMain.handle('item:finish', (_event, id: number, restoreEnvironment: boolean, skipTests: boolean) => runner.finish(id, restoreEnvironment, skipTests));
  ipcMain.handle('item:interrupt', (_event, id: number) => runner.interrupt(id));
  ipcMain.handle('item:send', (_event, id: number, text: string, images: string[]) => runner.reply(id, text, images));
  ipcMain.handle('chat:saveImage', (_event, bytes: ArrayBuffer, extension: string) => {
    const dir = join(dataDir, 'attachments');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.${/^(png|jpe?g|gif|webp)$/i.test(extension) ? extension.toLowerCase() : 'png'}`);
    writeFileSync(file, Buffer.from(bytes));
    return file;
  });
  // 截圖：用 macOS 內建的 screencapture（跟 ⌘⇧4 同一個工具，拖範圍、空白鍵截視窗、Esc 取消）。
  // FlowPilot 留在原地不藏起來（藏起來看起來像程式關掉了，使用者覺得可怕）；要截後面的視窗按空白鍵點那個視窗就好。
  // 不註冊任何快捷鍵。取消就回傳 null
  ipcMain.handle('shot:capture', async () => {
    const dir = join(dataDir, 'attachments');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `shot-${randomUUID()}.png`);
    await new Promise<void>((resolve) => execFile('screencapture', ['-i', '-x', file], () => resolve()));
    window?.focus();
    if (!existsSync(file)) return null;
    return { path: file, dataUrl: `data:image/png;base64,${readFileSync(file).toString('base64')}` };
  });
  ipcMain.handle('chat:history', async (_event, id: number) => {
    const item = store.getWorkItem(id);
    if (!item?.threadId) return [];
    // 對話太長換過新對話的：先接上舊對話的紀錄（到請它整理交接之前為止），再接目前的
    const entries = [];
    for (const old of item.oldThreads) {
      const history = await loadHistory(daemon, old).catch(() => []);
      const cut = history.findIndex((e) => e.kind === 'user' && e.text.startsWith(HANDOFF_PROMPT_TITLE));
      entries.push(...(cut >= 0 ? history.slice(0, cut) : history));
    }
    entries.push(...(await loadHistory(daemon, item.threadId)));
    return entries;
  });
  ipcMain.handle('git:state', async (_event, id: number) => {
    const { item, folder } = folderOf(id);
    return { ...(await gitState(folder.path, item.baseBranch)), identities: loadSettings(settingsFile).gitIdentities, retired: !!folder.retired };
  });
  ipcMain.handle('git:diff', (_event, id: number, path: string, staged: boolean) => fileDiff(folderOf(id).folder.path, path, staged));
  ipcMain.handle('git:stage', (_event, id: number, paths: string[]) => stage(folderOf(id).folder.path, paths));
  ipcMain.handle('git:unstage', (_event, id: number, paths: string[]) => unstage(folderOf(id).folder.path, paths));
  ipcMain.handle('git:discard', (_event, id: number, paths: string[]) => discard(folderOf(id).folder.path, paths));
  ipcMain.handle('git:commitAll', (_event, id: number, message: string, email?: string) => {
    const identity = email ? loadSettings(settingsFile).gitIdentities.find((i) => i.email === email) : undefined;
    if (email && !identity) throw new Error(t('設定檔的 gitIdentities 裡沒有 {email}', { email }));
    return commitAll(folderOf(id).folder.path, message, identity);
  });
  ipcMain.handle('git:commit', (_event, id: number, message: string, email?: string) => {
    // 只能用設定檔裡列出的身分
    const identity = email ? loadSettings(settingsFile).gitIdentities.find((i) => i.email === email) : undefined;
    if (email && !identity) throw new Error(t('設定檔的 gitIdentities 裡沒有 {email}', { email }));
    return commitStaged(folderOf(id).folder.path, message, identity);
  });
  ipcMain.handle('git:push', (_event, id: number) => pushBranch(folderOf(id).folder.path));
  ipcMain.handle('git:commits', async (_event, id: number) => {
    const src = await branchSource(id);
    return { where: src.where, ...(await branchCommits(src.cwd, src.ref, src.branch, src.base)) };
  });
  ipcMain.handle('git:commitFiles', async (_event, id: number, sha: string) => commitFiles((await branchSource(id)).cwd, sha));
  ipcMain.handle('git:commitDiff', async (_event, id: number, sha: string | null, path: string) => {
    const src = await branchSource(id);
    return commitDiff(src.cwd, src.ref, src.base, sha, path);
  });
  ipcMain.handle('folderTerm:open', (_event, id: number, cols: number, rows: number) => {
    const { folder } = folderOf(id);
    return { folder: folder.name, ...folderTerminals.open(folder.name, folder.path, cols, rows) };
  });
  ipcMain.on('folderTerm:input', (_event, folder: string, data: string) => folderTerminals.write(folder, data));
  ipcMain.on('folderTerm:resize', (_event, folder: string, cols: number, rows: number) => folderTerminals.resize(folder, cols, rows));
  ipcMain.on('folderTerm:interrupt', (_event, folder: string) => folderTerminals.interrupt(folder));
  ipcMain.handle('folderTerm:startSite', (_event, id: number) => {
    const { folder, rule } = folderOf(id);
    // 套件沒裝齊（例如同事只改了 package.json、鎖定檔沒跟著改）先補裝，不然網站編譯會失敗
    const missing = missingPackages(folder.path);
    if (missing.length) log(`${folder.name}：啟動網站前發現缺套件 ${missing.slice(0, 5).join('、')}，先補裝`);
    folderTerminals.run(folder.name, `${missing.length ? `${installCommand(false)} && ` : ''}${startCommand(rule?.startCommand, folder.port)}`);
  });
  // 本機網站用你平常的 Chrome 打開：AI 透過 Playwright 擴充功能接得上（你說「看我開的畫面」它就看得到）
  ipcMain.handle('shell:openUrl', (_event, url: string) => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) throw new Error(t('只能打開本機網址'));
    return openInChrome(url);
  });
  ipcMain.handle('item:retry', (_event, id: number) => runner.retry(id));
  ipcMain.handle('item:retest', (_event, id: number, mock: boolean) => runner.retest(id, mock));
  ipcMain.handle('item:rerunAutotest', (_event, id: number, mock: boolean, shared: boolean) => runner.rerunAutotest(id, mock, shared));
  ipcMain.handle('item:syncBase', (_event, id: number) => runner.syncBase(id));
  ipcMain.handle('test:closeBrowsers', () => closeTestBrowsers());
  ipcMain.handle('test:trialLogin', (_event, id: number) => trialLogin(id));
  ipcMain.handle('test:setManualDone', (_event, id: number, index: number, done: boolean) => runner.setManualDone(id, index, done));
  ipcMain.handle('test:setChecked', (_event, id: number, no: number, checked: boolean) => runner.setChecked(id, no, checked));
  ipcMain.handle('test:setSpecSeen', (_event, id: number, no: number, seen: boolean) => runner.setSpecSeen(id, no, seen));
  ipcMain.handle('item:rerunSpecCheck', (_event, id: number) => runner.rerunSpecCheck(id));
  ipcMain.handle('test:requestAcceptance', (_event, id: number) => runner.requestAcceptance(id));
  ipcMain.handle('test:changedFiles', (_event, id: number) => runner.changedFiles(id));
  // 驗收表匯出成 CSV：選存放位置（預設「下載」），存好在 Finder 標出來；取消就回傳 null
  // 分析報告：測試完成後從「更多」產生，存成桌面的 PDF（要幾分鐘，進度送回畫面）
  ipcMain.handle('report:generate', async (_event, id: number) => {
    const item = store.getWorkItem(id);
    if (!item?.testReport) throw new Error(t('這張單還沒有驗收表，測試完成後再產生'));
    if (['running', 'preparing'].includes(item.status)) throw new Error(t('AI 還在執行，請等它停下來再產生報告'));
    if (reportsRunning.has(id)) throw new Error(t('這張單的報告正在產生'));
    reportsRunning.add(id);
    const progress = (text: string) => window?.webContents.send('report:progress', id, text);
    try {
      const file = await generateReport(
        {
          codex,
          dataDir,
          // 讓出資料夾的單：用同專案的資料夾讀遠端分支
          cwd: projectFolder(item),
          head: item.folder ? 'HEAD' : `origin/${item.branch}`,
          review: store.getReview(item.ticketKey)?.review ?? null,
          log,
          progress,
        },
        item,
      );
      log(`${item.ticketKey}：分析報告存到 ${file}`);
      notify(t('{ticket} 分析報告好了', { ticket: item.ticketKey }), file, id);
      shell.showItemInFolder(file);
      return file;
    } finally {
      reportsRunning.delete(id);
      progress('');
    }
  });
  ipcMain.handle('test:exportCsv', async (_event, id: number) => {
    const item = store.getWorkItem(id);
    if (!item?.testReport) throw new Error(t('這張單還沒有驗收表'));
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const options = { title: t('匯出驗收表'), defaultPath: join(app.getPath('downloads'), t('{key}-驗收-{day}.csv', { key: item.ticketKey, day })), filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const target = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (target.canceled || !target.filePath) return null;
    writeFileSync(target.filePath, acceptanceCsv(item.testReport));
    shell.showItemInFolder(target.filePath);
    return target.filePath;
  });
  // 驗收截圖：只讀瀏覽器測試紀錄資料夾裡的圖片（檔名不能帶路徑）
  ipcMain.handle('test:shot', (_event, name: string) => {
    if (!/^[\w.\-]+\.(png|jpe?g)$/i.test(name)) return null;
    const file = join(dataDir, '瀏覽器測試紀錄', name);
    if (!existsSync(file)) return null;
    return `data:image/${/png$/i.test(name) ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}`;
  });
  ipcMain.handle('test:openPage', async (_event, id: number, page: string) => {
    await openInChrome(await runner.pageUrl(id, String(page ?? '')));
  });
  ipcMain.handle('tickets:marks', (_event, keys: string[]) => ticketMarks(keys));
  ipcMain.handle('test:state', (_event, id: number) => runner.testState(id));
  ipcMain.handle('test:setEnvironment', (_event, id: number, env: Env) => {
    if (env !== 'sit' && env !== 'uat') throw new Error(t('環境只能是 SIT 或 UAT'));
    return runner.switchEnvironment(id, env);
  });
  ipcMain.handle('item:openInVSCode', (_event, id: number) => runner.openInVSCode(id));
  ipcMain.handle('item:port', (_event, id: number) => runner.port(id));
  ipcMain.handle('item:park', (_event, id: number) => runner.park(id));
  ipcMain.handle('item:resume', (_event, id: number) => runner.resume(id));
  ipcMain.handle('item:switchBack', (_event, id: number) => runner.switchBack(id));
  ipcMain.handle('item:relocate', (_event, id: number) => runner.relocate(id));
}

// 盟軍外觀的提示音、語音：AI 做完時你可能沒在點畫面，也要能播
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  log(`啟動 FlowPilot ${app.getVersion()}（${app.isPackaged ? '打包版' : '開發版'}）`);
  loadSettings(settingsFile); // 第一次啟動時寫入預設設定，設定有錯也能及早發現
  store = new Store(join(dataDir, 'flowpilot.db'));
  // 審閱紀錄跟著工作台走：不在工作台上的單，審閱紀錄清掉
  const purged = store.purgeOrphanReviews();
  if (purged) log(`清掉 ${purged} 張不在工作台上的單的審閱紀錄`);
  runner = new Runner({
    store,
    settings: () => loadSettings(settingsFile),
    codex: daemon,
    // 打包後外掛放在 app.asar.unpacked（VS Code 讀不到 asar 裡的檔案）
    vscode: new VSCode(join(app.getAppPath(), 'resources/vscode-companion').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'), dataDir, (url) => shell.openExternal(url)),
    notify,
    paused,
    dataDir,
    writeGuard: writeGuardPath(),
    stopSite: (name) => folderTerminals.interrupt(name),
    ensureSite: (name) => {
      const settings = loadSettings(settingsFile);
      const folder = settings.folders.find((f) => f.name === name);
      if (!folder) throw new Error(t('設定檔裡沒有資料夾「{folder}」', { folder: name }));
      return folderTerminals.ensureSite(folder.name, folder.path, startCommand(settings.projects[folder.project]?.startCommand, folder.port), folder.port ?? 4200);
    },
    onChange: boardChanged,
    onStream: streamChanged,
    onChat: chatChanged,
    ensureSpec: (ticketKey) => ensureSpec(ticketKey),
    log,
  });
  registerIpc();
  // 審核中的 PR 有沒有衝突：每 10 分鐘看一次（用測試資料位置時不看）
  if (!paused) {
    setTimeout(() => void checkPrConflicts(), 60_000);
    setInterval(() => void checkPrConflicts(), 10 * 60_000);
    // 作戰室裡還沒估時的單補填（第一次會把現在作戰室裡的單都估上）
    setTimeout(() => void autoEstimate(), 15_000);
  }
  runner.resubscribe().catch((e) => log(`啟動時接回工作失敗：${e.message}`));
  createTray();
  showWindow();
  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  log('結束 FlowPilot');
  quitting = true;
  folderTerminals.closeAll();
  codex.stop();
  daemon.stop(); // 只斷開連線；常駐服務繼續跑，進行中的 AI 不受影響
});

// 資料庫在程式真的要結束時才關：結束途中可能還有幾則 Codex 訊息在處理
process.on('exit', () => store?.close());

// 視窗全部關掉也不結束（背景繼續跑）
app.on('window-all-closed', () => {});
