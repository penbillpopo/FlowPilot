// 應用程式主程序：選單列圖示＋主視窗。關掉視窗不會結束，背景繼續跑；從選單列「結束」才真的關掉。
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraTicket, Judgement, PlanOptions, TicketPlan } from '../shared/types';
import { CodexRpc } from './codex/rpc';
import { askStructured, listSkills } from './codex/structured';
import { checkExisting } from './git';
import { getIssueContext, loadCredentials, searchTickets } from './jira';
import { buildJudgePrompt, JUDGE_INSTRUCTIONS, judgementSchema, sanitizeJudgement } from './planner/judge';
import { deriveBranches, planProblem } from './planner/rules';
import { Runner } from './runner/runner';
import { VSCode } from './vscode';
import { loadSettings } from './settings';
import { Store } from './store';

const dataDir = join(app.getPath('appData'), 'FlowPilot');
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

async function judgeTicket(ticket: JiraTicket): Promise<Judgement> {
  const settings = loadSettings(settingsFile);
  const credentials = loadCredentials(settings.jira.envFile);
  const [sub, main] = await Promise.all([
    getIssueContext(credentials, ticket.key),
    ticket.parent ? getIssueContext(credentials, ticket.parent.key) : Promise.resolve(null),
  ]);
  const raw = await withJudgeSlot(() =>
    askStructured<Judgement>(codex, {
      cwd: dataDir,
      developerInstructions: JUDGE_INSTRUCTIONS,
      prompt: buildJudgePrompt(ticket, sub, main, settings, store.recentDecisions()),
      schema: judgementSchema(settings),
    }),
  );
  return sanitizeJudgement(raw, ticket.key, settings);
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
  ipcMain.handle('tickets:list', async () => {
    // 每次都重讀設定，改完設定檔不用重開
    const settings = loadSettings(settingsFile);
    return searchTickets(loadCredentials(settings.jira.envFile), settings.jira.jql);
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
      projects: Object.entries(settings.projects).map(([name, rule]) => ({ name, merchants: rule.merchants?.length ? rule.merchants : null })),
      defaultSkill: settings.defaultSkill,
    };
  });
  ipcMain.handle('skills:list', () => listSkills(codex, loadSettings(settingsFile).folders[0]?.path ?? dataDir));
  ipcMain.handle('plan:judge', (_event, ticket: JiraTicket) => judgeTicket(ticket));
  ipcMain.handle('plan:check', (_event, plans: TicketPlan[], fetch: boolean) => {
    const settings = loadSettings(settingsFile);
    const branches = plans.filter((p) => !planProblem(p, settings)).flatMap((p) => deriveBranches(p, settings));
    return checkExisting(branches, settings.folders, { fetch });
  });
  ipcMain.handle('plan:confirm', async (_event, runId: number, plans: TicketPlan[], judgements: Record<string, Judgement>) => {
    const settings = validatePlans(plans);
    // 確認前再檢查一次：中間可能有人建立了分支
    const existing = (await checkExisting(plans.flatMap((p) => deriveBranches(p, settings)), settings.folders)).filter((b) => b.existsIn.length);
    if (existing.length) throw new Error(`這些分支已經建立：${existing.map((b) => b.branch).join('、')}，請重新檢查`);
    const run = store.confirmPlan(runId, plans, judgements);
    runner.startRun(runId); // 確認計畫後直接開始：建立分支、分配資料夾、啟動 AI
    return run;
  });
  ipcMain.handle('board:get', () => runner.board());
  ipcMain.handle('board:startRun', (_event, runId: number) => runner.startRun(runId));
  ipcMain.handle('item:reply', (_event, id: number, text: string) => runner.reply(id, text));
  ipcMain.handle('item:approve', (_event, id: number, accept: boolean) => runner.approve(id, accept));
  ipcMain.handle('item:stop', (_event, id: number) => runner.stop(id));
  ipcMain.handle('item:retry', (_event, id: number) => runner.retry(id));
  ipcMain.handle('item:openInVSCode', (_event, id: number) => runner.openInVSCode(id));
}

app.whenReady().then(() => {
  loadSettings(settingsFile); // 第一次啟動時寫入預設設定，設定有錯也能及早發現
  store = new Store(join(dataDir, 'flowpilot.db'));
  runner = new Runner({
    store,
    settings: () => loadSettings(settingsFile),
    codex: daemon,
    vscode: new VSCode(join(app.getAppPath(), 'resources/vscode-companion'), dataDir, (url) => shell.openExternal(url)),
    notify,
    onChange: boardChanged,
    log,
  });
  registerIpc();
  runner.resubscribe().catch((e) => log(`啟動時接回工作失敗：${e.message}`));
  createTray();
  showWindow();
  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  quitting = true;
  codex.stop();
  daemon.stop(); // 只斷開連線；常駐服務繼續跑，進行中的 AI 不受影響
  store?.close();
});

// 視窗全部關掉也不結束（背景繼續跑）
app.on('window-all-closed', () => {});
