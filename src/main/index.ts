// 應用程式主程序：選單列圖示＋主視窗。關掉視窗不會結束，背景繼續跑；從選單列「結束」才真的關掉。
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Env, JiraTicket, Judgement, PlanOptions, Review, ReviewIssue, TicketPlan, TicketSnapshot } from '../shared/types';
import { CodexRpc } from './codex/rpc';
import { listSkills, runStructured } from './codex/structured';
import { checkExisting } from './git';
import { buildJql, getIssueContext, loadCredentials, searchTickets, statusIdsByName } from './jira';
import { applyDiscussion, buildCodeCheckPrompt, buildDiscussionPrompt, buildReviewPrompt, discussionSchema, REVIEW_INSTRUCTIONS, reviewSchema, sanitizeReview } from './planner/review';
import { deriveBranches, planProblem } from './planner/rules';
import { loadHistory } from './chat';
import { FolderTerminals } from './folderterminals';
import { commitStaged, discard, fileDiff, gitState, pushBranch, stage, unstage } from './gitpanel';
import { diffSnapshots, updateMessage } from './requirements';
import { Runner } from './runner/runner';
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
  if (!item?.folder) throw new Error('這張單還沒有分配資料夾');
  const settings = loadSettings(settingsFile);
  const folder = settings.folders.find((f) => f.name === item.folder);
  if (!folder) throw new Error(`設定檔裡沒有資料夾「${item.folder}」`);
  return { item, folder, rule: settings.projects[folder.project] };
}

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
async function reviewTicket(ticket: JiraTicket, force = false): Promise<Review> {
  const saved = store.getReview(ticket.key);
  if (saved && !force) return saved.review;
  const settings = loadSettings(settingsFile);
  const credentials = loadCredentials(settings.jira.envFile);
  const [sub, main] = await Promise.all([
    getIssueContext(credentials, ticket.key),
    ticket.parent ? getIssueContext(credentials, ticket.parent.key) : Promise.resolve(null),
  ]);
  const { result, threadId } = await withJudgeSlot(() =>
    runStructured<any>(codex, {
      cwd: dataDir,
      keep: true, // 保留對話，之後可以接著討論
      developerInstructions: REVIEW_INSTRUCTIONS,
      prompt: buildReviewPrompt(ticket, sub, main, settings, store.recentDecisions()),
      schema: reviewSchema(settings),
      timeoutMs: 300_000,
    }),
  );
  let review = sanitizeReview(result, ticket, settings);
  // 一般、複雜的單一定要大略看過程式碼：AI 第一輪沒看，就在同一段對話追加一輪，指定專案資料夾
  const codePrompt = review.level !== '小' && !review.codeChecked ? buildCodeCheckPrompt(review.entries.map((e) => e.project), settings) : null;
  if (codePrompt) {
    try {
      const checked = await withJudgeSlot(() =>
        runStructured<any>(codex, { cwd: dataDir, keep: true, threadId, developerInstructions: REVIEW_INSTRUCTIONS, prompt: codePrompt, schema: reviewSchema(settings), timeoutMs: 300_000 }),
      );
      review = sanitizeReview({ ...checked.result, codeChecked: true }, ticket, settings);
    } catch (error) {
      log(`${ticket.key} 看程式碼失敗，先用只看單的結果：${(error as Error).message}`);
    }
  }
  // 參考資料直接從 Jira 擷取（主單在前），不經過 AI；同一個網址只留一筆
  const seen = new Set<string>();
  review.resources = [...(main?.resources ?? []), ...sub.resources].filter((r) => !seen.has(r.url) && seen.add(r.url));
  // 存下這次讀到的內容，之後比對 PM 有沒有改單
  review.snapshot = [sub.snapshot, ...(main ? [main.snapshot] : [])];
  store.saveReview(review, threadId);
  return review;
}

// ---- 需求變更 ----

/**
 * 更新需求（你按了才做）：重新讀 Jira，跟上次確認過的內容比對，把結果交給這張單的 AI，
 * AI 在對話裡回答有沒有變更、打算怎麼改；這次讀到的內容變成新的快照。
 */
async function requestRequirementUpdate(itemId: number): Promise<void> {
  const item = store.getWorkItem(itemId);
  if (!item) throw new Error('找不到這張單');
  if (!item.threadId) throw new Error('這張單還沒開始開發，開始之後才能更新需求');
  const saved = store.getReview(item.ticketKey);
  const keys = saved?.review.snapshot?.map((s) => s.key) ?? [...new Set([item.ticketKey, item.mainKey])];
  const credentials = loadCredentials(loadSettings(settingsFile).jira.envFile);
  const fresh: TicketSnapshot[] = [];
  for (const key of keys) fresh.push((await getIssueContext(credentials, key)).snapshot);
  const changes = saved?.review.snapshot?.length ? diffSnapshots(saved.review.snapshot, fresh, item.ticketKey) : null;
  await runner.reply(itemId, updateMessage(changes, fresh));
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
  if (!saved) throw new Error(`${ticketKey} 還沒有審閱`);
  const review: Review = {
    ...saved.review,
    issues: saved.review.issues.map((i) => (i.id === issueId ? { ...i, status: patch.status, answer: patch.status === 'answered' ? (patch.answer ?? '').trim() : undefined } : i)),
  };
  store.saveReview(review, saved.threadId);
  return review;
}

async function discussReview(ticketKey: string, text: string): Promise<Review> {
  const saved = store.getReview(ticketKey);
  if (!saved) throw new Error(`${ticketKey} 還沒有審閱`);
  if (!text.trim()) throw new Error('訊息是空的');
  const request = { cwd: dataDir, keep: true, developerInstructions: REVIEW_INSTRUCTIONS, schema: discussionSchema, prompt: buildDiscussionPrompt(saved.review, text), timeoutMs: 300_000 };
  // 接著審閱時的對話討論（AI 記得單和程式碼）；對話不在了就開一段新的
  const { result, threadId } = await runStructured<any>(codex, { ...request, threadId: saved.threadId ?? undefined }).catch(() => runStructured<any>(codex, request));
  const review = applyDiscussion(saved.review, text.trim(), result);
  store.saveReview(review, threadId);
  return review;
}

function validatePlans(plans: TicketPlan[]) {
  const settings = loadSettings(settingsFile);
  for (const plan of plans) {
    const problem = planProblem(plan, settings);
    if (problem) throw new Error(`${plan.ticket.key}：${problem}`);
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打開 FlowPilot', click: showWindow },
      { label: '打開設定檔', click: () => shell.openPath(settingsFile) },
      { type: 'separator' },
      { label: '結束 FlowPilot', click: () => app.quit() },
    ]),
  );
}

function registerIpc() {
  ipcMain.handle('tickets:list', async (_event, statuses: string[]) => {
    // 每次都重讀設定，改完設定檔不用重開
    const settings = loadSettings(settingsFile);
    const credentials = loadCredentials(settings.jira.envFile);
    return searchTickets(credentials, buildJql(settings.jira.filter, statuses, await statusIdsByName(credentials)));
  });
  ipcMain.handle('tickets:statusOptions', () => {
    const { statuses, defaultStatuses } = loadSettings(settingsFile).jira;
    return { statuses, defaultStatuses };
  });
  ipcMain.handle('run:create', (_event, tickets: JiraTicket[]) => store.createRun(tickets));
  ipcMain.handle('run:latest', () => store.latestRun());
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('只能打開 https 網址');
    return shell.openExternal(url);
  });
  ipcMain.handle('settings:open', () => shell.openPath(settingsFile).then(() => undefined));
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
  ipcMain.handle('review:run', (_event, ticket: JiraTicket, force: boolean) => reviewTicket(ticket, force));
  ipcMain.handle('review:updateIssue', (_event, ticketKey: string, issueId: string, patch: { status: ReviewIssue['status']; answer?: string }) => updateIssue(ticketKey, issueId, patch));
  ipcMain.handle('review:discuss', (_event, ticketKey: string, text: string) => discussReview(ticketKey, text));
  ipcMain.handle('req:update', (_event, itemId: number) => requestRequirementUpdate(itemId));
  ipcMain.handle('plan:check', (_event, plans: TicketPlan[], fetch: boolean) => {
    const settings = loadSettings(settingsFile);
    const branches = plans.filter((p) => !planProblem(p, settings)).flatMap((p) => deriveBranches(p, settings));
    return checkExisting(branches, settings.folders, { fetch });
  });
  ipcMain.handle('plan:confirm', async (_event, runId: number, plans: TicketPlan[], judgements: Record<string, Judgement>) => {
    const settings = validatePlans(plans);
    // 確認前再檢查一次：已存在的分支會切過去繼續開發，但存在於好幾個資料夾時一定要選好用哪一個
    const branches = await checkExisting(plans.flatMap((p) => deriveBranches(p, settings)), settings.folders);
    for (const plan of plans) {
      for (const entry of plan.entries) {
        const local = branches.find((b) => b.ticketKey === plan.ticket.key && b.project === entry.project && b.role !== 'target')?.existsIn.filter((w) => w !== '遠端') ?? [];
        if (local.length > 1 && (!entry.folder || !local.includes(entry.folder))) {
          throw new Error(`${plan.ticket.key}：分支在 ${local.join('、')} 都有，請選擇要用哪一個資料夾`);
        }
      }
    }
    const run = store.confirmPlan(runId, plans, judgements);
    runner.startRun(runId); // 確認計畫後直接開始：建立分支、分配資料夾、啟動 AI
    return run;
  });
  ipcMain.handle('board:get', () => runner.board());
  ipcMain.handle('board:startRun', (_event, runId: number) => runner.startRun(runId));
  ipcMain.handle('item:reply', (_event, id: number, text: string) => runner.reply(id, text));
  ipcMain.handle('item:approve', (_event, id: number, accept: boolean) => runner.approve(id, accept));
  ipcMain.handle('item:decide', (_event, id: number, optionId: string) => runner.decide(id, optionId));
  ipcMain.handle('item:stop', (_event, id: number) => runner.stop(id));
  ipcMain.handle('item:remove', (_event, id: number, deleteBranch?: boolean) => runner.remove(id, !!deleteBranch));
  ipcMain.handle('item:branchInfo', (_event, id: number) => runner.branchInfo(id));
  ipcMain.handle('item:finish', (_event, id: number, restoreEnvironment: boolean) => runner.finish(id, restoreEnvironment));
  ipcMain.handle('item:interrupt', (_event, id: number) => runner.interrupt(id));
  ipcMain.handle('item:send', (_event, id: number, text: string, images: string[]) => runner.reply(id, text, images));
  ipcMain.handle('chat:saveImage', (_event, bytes: ArrayBuffer, extension: string) => {
    const dir = join(dataDir, 'attachments');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.${/^(png|jpe?g|gif|webp)$/i.test(extension) ? extension.toLowerCase() : 'png'}`);
    writeFileSync(file, Buffer.from(bytes));
    return file;
  });
  ipcMain.handle('chat:history', (_event, id: number) => {
    const item = store.getWorkItem(id);
    return item?.threadId ? loadHistory(daemon, item.threadId) : [];
  });
  ipcMain.handle('git:state', async (_event, id: number) => {
    const { item, folder } = folderOf(id);
    return { ...(await gitState(folder.path, item.baseBranch)), identities: loadSettings(settingsFile).gitIdentities };
  });
  ipcMain.handle('git:diff', (_event, id: number, path: string, staged: boolean) => fileDiff(folderOf(id).folder.path, path, staged));
  ipcMain.handle('git:stage', (_event, id: number, paths: string[]) => stage(folderOf(id).folder.path, paths));
  ipcMain.handle('git:unstage', (_event, id: number, paths: string[]) => unstage(folderOf(id).folder.path, paths));
  ipcMain.handle('git:discard', (_event, id: number, paths: string[]) => discard(folderOf(id).folder.path, paths));
  ipcMain.handle('git:commit', (_event, id: number, message: string, email?: string) => {
    // 只能用設定檔裡列出的身分
    const identity = email ? loadSettings(settingsFile).gitIdentities.find((i) => i.email === email) : undefined;
    if (email && !identity) throw new Error(`設定檔的 gitIdentities 裡沒有 ${email}`);
    return commitStaged(folderOf(id).folder.path, message, identity);
  });
  ipcMain.handle('git:push', (_event, id: number) => pushBranch(folderOf(id).folder.path));
  ipcMain.handle('folderTerm:open', (_event, id: number, cols: number, rows: number) => {
    const { folder } = folderOf(id);
    return { folder: folder.name, ...folderTerminals.open(folder.name, folder.path, cols, rows) };
  });
  ipcMain.on('folderTerm:input', (_event, folder: string, data: string) => folderTerminals.write(folder, data));
  ipcMain.on('folderTerm:resize', (_event, folder: string, cols: number, rows: number) => folderTerminals.resize(folder, cols, rows));
  ipcMain.on('folderTerm:interrupt', (_event, folder: string) => folderTerminals.interrupt(folder));
  ipcMain.handle('folderTerm:startSite', (_event, id: number) => {
    const { folder, rule } = folderOf(id);
    folderTerminals.run(folder.name, startCommand(rule?.startCommand, folder.port));
  });
  ipcMain.handle('shell:openUrl', (_event, url: string) => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) throw new Error('只能打開本機網址');
    return shell.openExternal(url);
  });
  ipcMain.handle('item:retry', (_event, id: number) => runner.retry(id));
  ipcMain.handle('item:retest', (_event, id: number) => runner.retest(id));
  ipcMain.handle('test:state', (_event, id: number) => runner.testState(id));
  ipcMain.handle('test:setEnvironment', (_event, id: number, env: Env) => {
    if (env !== 'sit' && env !== 'uat') throw new Error('環境只能是 SIT 或 UAT');
    return runner.switchEnvironment(id, env);
  });
  ipcMain.handle('item:openInVSCode', (_event, id: number) => runner.openInVSCode(id));
}

app.whenReady().then(() => {
  log(`啟動 FlowPilot ${app.getVersion()}（${app.isPackaged ? '打包版' : '開發版'}）`);
  loadSettings(settingsFile); // 第一次啟動時寫入預設設定，設定有錯也能及早發現
  store = new Store(join(dataDir, 'flowpilot.db'));
  runner = new Runner({
    store,
    settings: () => loadSettings(settingsFile),
    codex: daemon,
    // 打包後外掛放在 app.asar.unpacked（VS Code 讀不到 asar 裡的檔案）
    vscode: new VSCode(join(app.getAppPath(), 'resources/vscode-companion').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'), dataDir, (url) => shell.openExternal(url)),
    notify,
    paused,
    dataDir,
    ensureSite: (name) => {
      const settings = loadSettings(settingsFile);
      const folder = settings.folders.find((f) => f.name === name);
      if (!folder) throw new Error(`設定檔裡沒有資料夾「${name}」`);
      return folderTerminals.ensureSite(folder.name, folder.path, startCommand(settings.projects[folder.project]?.startCommand, folder.port), folder.port ?? 4200);
    },
    onChange: boardChanged,
    onStream: streamChanged,
    onChat: chatChanged,
    log,
  });
  registerIpc();
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
