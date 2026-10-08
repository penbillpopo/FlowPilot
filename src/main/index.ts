// 應用程式主程序：選單列圖示＋主視窗。關掉視窗不會結束，背景繼續跑；從選單列「結束」才真的關掉。
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraTicket, Judgement, PlanOptions, TicketPlan } from '../shared/types';
import { CodexRpc } from './codex/rpc';
import { askStructured, listSkills } from './codex/structured';
import { checkExisting } from './git';
import { buildJql, getIssueContext, loadCredentials, searchTickets, statusIdsByName } from './jira';
import { buildJudgePrompt, JUDGE_INSTRUCTIONS, judgementSchema, sanitizeJudgement } from './planner/judge';
import { deriveBranches, planProblem } from './planner/rules';
import { Runner } from './runner/runner';
import { Terminals } from './terminals';
import { VSCode } from './vscode';
import { loadSettings } from './settings';
import { Store } from './store';

// 測試時可以用 FLOWPILOT_DATA_DIR 指定另一個資料位置，不碰到正式的設定與資料庫
const dataDir = process.env.FLOWPILOT_DATA_DIR || join(app.getPath('appData'), 'FlowPilot');
if (process.env.FLOWPILOT_DATA_DIR) app.setPath('userData', join(dataDir, 'electron'));
const settingsFile = join(dataDir, '設定.yaml');

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Store;
let runner: Runner;
const terminals = new Terminals((channel, ...args) => window?.webContents.send(channel, ...args), (m) => log(m));
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
  ipcMain.handle('item:remove', (_event, id: number) => runner.remove(id));
  ipcMain.handle('item:handOff', (_event, id: number) => runner.handOff(id));
  ipcMain.handle('item:changedFiles', (_event, id: number) => runner.changedFiles(id));
  ipcMain.handle('item:commit', (_event, id: number, files: string[]) => runner.commit(id, files));
  ipcMain.handle('item:retry', (_event, id: number) => runner.retry(id));
  ipcMain.handle('item:openInVSCode', (_event, id: number) => runner.openInVSCode(id));
  ipcMain.handle('term:open', (_event, id: number, cols: number, rows: number) => {
    const item = store.getWorkItem(id);
    if (!item?.threadId || !item.folder) throw new Error('這張單還沒有 AI 對話');
    const folder = loadSettings(settingsFile).folders.find((f) => f.name === item.folder);
    if (!folder) throw new Error(`設定檔裡沒有資料夾「${item.folder}」`);
    return terminals.open(id, { threadId: item.threadId, cwd: folder.path, cols, rows });
  });
  ipcMain.on('term:input', (_event, id: number, data: string) => terminals.write(id, data));
  ipcMain.on('term:resize', (_event, id: number, cols: number, rows: number) => terminals.resize(id, cols, rows));
  ipcMain.handle('term:close', (_event, id: number) => terminals.close(id));
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
    onStream: streamChanged,
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
  terminals.closeAll();
  codex.stop();
  daemon.stop(); // 只斷開連線；常駐服務繼續跑，進行中的 AI 不受影響
  store?.close();
});

// 視窗全部關掉也不結束（背景繼續跑）
app.on('window-all-closed', () => {});
