// 執行器：把確認好的計畫變成工作項目，分配資料夾、建立並切換分支、啟動 Codex 執行技能，
// 並追蹤每段對話的進度、提問與同意請求。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BoardState, BranchInfo, ChatEvent, Env, RemoveResult, Review, TestReport, TestResult, PendingRequest, SkillInfo, TestState, TicketPlan, WorkStage } from '../../shared/types';
import { toEntry } from '../chat';
import { apiHosts, ENVIRONMENT_FILE, readApiUrl, readEnvironment, setEnvironment } from '../environment';
import { reviewBrief } from '../planner/review';
import { configFile, resolveAccount, writeAccountFile } from '../testaccounts';
import type { CodexRpc, RpcMessage } from '../codex/rpc';
import { listSkills } from '../codex/structured';
import {
  aheadBehind,
  commitsSinceBase,
  createBranch,
  currentBranch,
  dirtyFiles,
  fastForward,
  fetchOrigin,
  fileHash,
  localBranchExists,
  remoteBranchExists,
  runGit,
  switchBranch,
  switchToRemoteBranch,
} from '../git';
import { deriveBranches } from '../planner/rules';
import type { Settings } from '../settings';
import { FINISHED, OCCUPYING, type StoredWorkItem, type Store } from '../store';
import type { VSCode } from '../vscode';
import { pickFolder } from './allocate';
import { commandPolicy, looksLikeQuestion, parseTestReport, parseTestResult } from './policy';

export interface RunnerDeps {
  store: Store;
  settings: () => Settings;
  /** 開發用：連到共用常駐服務 */
  codex: CodexRpc;
  vscode: VSCode;
  notify: (title: string, body: string, itemId: number) => void;
  onChange: () => void;
  /** AI 正在寫的回覆有新內容（即時顯示用，很頻繁，由呼叫端合併後再送畫面） */
  onStream: (itemId: number, text: string) => void;
  /** 聊天紀錄的即時更新（新的一則、或某一則多了內容） */
  onChat?: (itemId: number, event: ChatEvent) => void;
  log: (message: string) => void;
  /** 暫停：不排程、不準備資料夾、不啟動 AI（用測試資料位置看畫面時，避免動到真正的專案） */
  paused?: boolean;
  /** FlowPilot 的資料位置：瀏覽器測試的截圖紀錄、這次測試的登入資料放這裡（不放進專案） */
  dataDir: string;
  /** 確保資料夾的本機網站有在跑（沒在跑就在資料夾終端機啟動），回傳網址 */
  ensureSite: (folder: string) => Promise<string>;
  /** 測試瀏覽器的寫入防護程式（resources/write-guard.cjs 的完整路徑） */
  writeGuard: string;
  /** 停掉資料夾終端機裡的本機網站（完成這張單時） */
  stopSite?: (folder: string) => void;
  /** 連不連得到這個網址（瀏覽器測試前先確認後端，沒開 VPN 時馬上知道）；不給就用真的連線 */
  canReach?: (url: string) => Promise<boolean>;
}

/** 有任何回應就算連得到（後端回 404、401 也是連上了）；5 秒沒回應或連線失敗就是連不到 */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

const APPROVAL_METHODS = /requestApproval$|^execCommandApproval$|^applyPatchApproval$/;

/** 瀏覽器工具的名稱：自動測試用無頭的，重測用有頭的 */
const HEADLESS_BROWSER = 'flowpilot_browser_headless';
export const HEADLESS_BROWSER_NAME = HEADLESS_BROWSER;
const HEADED_BROWSER = 'flowpilot_browser';

/**
 * 開發用對話的設定（只在 FlowPilot 開的對話裡生效，不改你的 ~/.codex/config.toml）：
 * - 關掉 Codex 內建的「控制電腦／瀏覽器」。實測：開著時 AI 會用它去開 Figma 網頁（在常駐服務裡用不了，就放棄），關掉後才會改用 Figma MCP。
 * - 瀏覽器測試改用 FlowPilot 提供的兩套 Playwright：無頭（自動測試）與有頭（重測給你看），
 *   截圖紀錄放在 FlowPilot 的資料夾，不會弄髒專案；你原本的 playwright 在這些對話裡關掉，AI 才不會用錯。
 */
/** 這張單的測試瀏覽器把擋下、放行的請求記在這裡（每次測試開始時清空） */
export function requestLogFile(dataDir: string, itemId: number): string {
  return join(dataDir, '測試請求', `${itemId}.jsonl`);
}

export function threadConfig(dataDir: string, writeGuard: string, itemId: number, hosts: string[] = []) {
  const outputDir = join(dataDir, '瀏覽器測試紀錄');
  // 兩套測試瀏覽器都套上寫入防護（resources/write-guard.cjs）：會改資料的請求擋下、記下內容、回假的成功
  const browser = (extra: string[]) => ({
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', ...extra, '--isolated', '--caps', 'devtools', '--output-dir', outputDir, '--init-page', writeGuard],
    env: { FLOWPILOT_REQUEST_LOG: requestLogFile(dataDir, itemId), FLOWPILOT_API_HOSTS: hosts.join(',') },
  });
  let hasOwnPlaywright = false;
  try {
    hasOwnPlaywright = /^\[mcp_servers\.playwright\]/m.test(readFileSync(join(homedir(), '.codex/config.toml'), 'utf8'));
  } catch {}
  return {
    features: { computer_use: false, browser_use: false, browser_use_external: false },
    mcp_servers: {
      ...(hasOwnPlaywright ? { playwright: { enabled: false } } : {}),
      [HEADLESS_BROWSER]: browser(['--headless']),
      [HEADED_BROWSER]: browser(['--browser', 'chrome']),
    },
  };
}

const STAGE_DONE: Partial<Record<WorkStage, string>> = {
  autotest: '自動測試完成，等你手動測試',
  fix: '改好了，等你測試',
  retest: '重測完成，等你確認',
  manual: '需求比對完了，等你測試',
};

/** 要 AI 在最後附上的測試報告（預期結果對照、要你手動測的項目），FlowPilot 讀這段畫成對照表和清單 */
function reportLines(review: Review | null): string[] {
  const acceptance = review?.acceptance ?? [];
  return [
    acceptance.length
      ? `- 預期結果要一條一條對照：${acceptance.map((a, i) => `${i + 1}. ${a}`).join('　')}`
      : '- 預期結果要一條一條對照（照單上的「預期結果」拆成一條一句）。',
    '- 回覆最後、在「測試結果」那一行之前，附上這段（FlowPilot 會讀它畫成對照表和手動測試清單；JSON 要合法）：',
    '  ```flowpilot-test',
    '  {"acceptance":[{"no":1,"text":"預期結果的內容","result":"通過、沒過或沒測","note":"證據或原因，一句話"}],"manual":["要我手動測的項目，一項一句"]}',
    '  ```',
  ];
}

/** 檢查計畫要比對設計稿、單上也有 Figma 連結時，加進測試指示的要求 */
function designCompareLines(review: Review | null): string[] {
  const figma = (review?.resources ?? []).filter((r) => r.kind === 'figma').map((r) => r.url).slice(0, 3);
  if (!review?.checks?.designCompare.need || !figma.length) return [];
  return [
    `- 比對設計稿：測到新畫面時截圖，用 Figma 工具看設計稿（${figma.join('、')}），比對流程、欄位、按鈕、文案有沒有明顯不一樣；間距、排版、顏色這類細節不用管。差很多的列在結果裡。`,
  ];
}

/** 測試做完後給人看的一句話 */
function testActivity(label: string, result: TestResult): string {
  const why = result.reason ? `：${result.reason}` : '';
  switch (result.kind) {
    case 'passed':
      return `${label}通過，等你手動測試`;
    case 'partial':
      return `${label}部分通過${why}，等你手動測試`;
    case 'failed':
      return `${label}沒測成${why}`;
    default:
      return `${label}做完了，看最後的結果，等你手動測試`;
  }
}

/** 瀏覽器測試切換 SIT／UAT 時會改的檔案 */
function isEnvironmentFile(path: string): boolean {
  return /(^|\/)src\/environments\/environment[^/]*\.ts$/.test(path);
}

function short(text: string, max = 120) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 在資料夾裡用登入 shell 執行（拿得到 nvm 的 node／npm） */
function shell(cwd: string, command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(process.env.SHELL || '/bin/zsh', ['-l', '-c', command], { cwd, timeout: timeoutMs, env, maxBuffer: 50 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) reject(new Error(short(stderr.toString().split('\n').filter(Boolean).slice(-3).join(' ') || error.message, 300)));
      else resolve();
    });
  });
}

export class Runner {
  /** 每段對話目前那一輪的編號（補充指示、停止時要用） */
  private turns = new Map<string, string>();
  private skills: SkillInfo[] | null = null;
  /**
   * 子 AI 的對話編號 → 屬於哪張單。Codex 的多 AI 協作沒辦法從設定關掉，AI 有時會自己開子 AI；
   * 子 AI 要求同意時用的是自己的對話編號，FlowPilot 不認得就不會回，兩邊互等卡住（實際卡過 20 分鐘）
   */
  private childThreads = new Map<string, number>();
  /** AI 正在寫、還沒寫完的回覆（只放記憶體；寫完才存進資料庫） */
  private streaming = new Map<number, string>();
  /** 你在準備階段已經同意的事（接著未提交的修改做、用本機版本繼續） */
  private allowed = new Map<number, Set<'dirty' | 'diverged'>>();
  /** 準備好之後，交代給 AI 時要說明的現況 */
  private prepared = new Map<number, { continuing: boolean; commits: number; dirty: number; rebase?: { behind: number; conflict: boolean } }>();
  private scheduling = false;
  private rescheduleRequested = false;

  constructor(private readonly deps: RunnerDeps) {
    deps.codex.on((message) => this.handle(message).catch((e) => deps.log(`處理 Codex 訊息失敗：${e.message}`)));
    setInterval(() => {
      if (this.deps.store.listWorkItems().some((i) => i.status === 'queued')) void this.schedule();
    }, 60_000);
    deps.codex.setDisconnectHandler(() => {
      deps.log('跟 Codex 常駐服務的連線中斷，5 秒後重新連線');
      setTimeout(() => this.resubscribe().catch((e) => deps.log(`重新連線失敗：${e.message}`)), 5000);
    });
  }

  // ---- 看板 ----

  board(): BoardState {
    const { store } = this.deps;
    const items = store.listWorkItems();
    const occupiedBy = new Map(items.filter((i) => i.folder && OCCUPYING.includes(i.status)).map((i) => [i.folder!, i.id]));
    return {
      folders: this.deps.settings().folders.map((f) => ({ ...f, itemId: occupiedBy.get(f.name) ?? null })),
      items: items.map(({ branchCreated: _, commitSha: __, ...item }) => item),
      pendingRun: store.pendingPlannedRun(),
      streaming: Object.fromEntries(this.streaming),
    };
  }

  /** 進行中的單停下來等你、做完或失敗時跳系統通知（每一張進行中的單都會通知） */
  private notify(id: number, title: string, body: string) {
    this.deps.notify(title, body, id);
  }

  private update(id: number, patch: Parameters<Store['updateWorkItem']>[1]): StoredWorkItem {
    const item = this.deps.store.updateWorkItem(id, patch);
    this.deps.onChange();
    return item;
  }

  // ---- 開始執行 ----

  /**
   * 把確認好的計畫變成工作項目並開始排程（多商戶只建立來源，目標之後移植）。
   * 同一條分支在看板上已經有還沒結束的工作，就不重複建立，回傳被略過的分支。
   */
  startRun(runId: number): string[] {
    const { store } = this.deps;
    const plans = store.getPlan(runId);
    if (!plans) throw new Error(`第 ${runId} 次執行沒有確認好的計畫`);
    const settings = this.deps.settings();
    const items = plans.flatMap((plan: TicketPlan) => {
      const branches = deriveBranches(plan, settings);
      return branches
        .filter((b) => b.role !== 'target')
        .map((b) => ({
          runId,
          ticketKey: plan.ticket.key,
          ticketSummary: plan.ticket.summary,
          mainKey: plan.ticket.parent?.key ?? plan.ticket.key,
          mainUrl: plan.ticket.parent?.url ?? plan.ticket.url,
          project: b.project,
          merchant: b.merchant,
          targetMerchants: branches.filter((t) => t.role === 'target' && t.project === b.project).map((t) => t.merchant!),
          branch: b.branch,
          baseBranch: b.baseBranch,
          skill: settings.projects[b.project]?.devSkill ?? 'frontend-development',
          prTitle: plan.prTitle,
          preferredFolder: plan.entries.find((e) => e.project === b.project)?.folder ?? null,
        }));
    });
    const skipped = items.filter((i) => store.activeWorkItem(i.project, i.branch)).map((i) => i.branch);
    const fresh = items.filter((i) => !skipped.includes(i.branch));
    if (fresh.length) store.createWorkItems(fresh);
    else store.markRunStarted(runId);
    if (skipped.length) this.deps.log(`第 ${runId} 次執行：這些分支已經有進行中的工作，不重複建立：${skipped.join('、')}`);
    this.deps.onChange();
    void this.schedule();
    return skipped;
  }

  /**
   * 排程：同時進行的單數由資料夾決定（每個資料夾一次一張）。
   * 每個專案照計畫順序，有空的資料夾就開始下一張；拿不到資料夾的留在排隊，並在說明寫出原因。
   * 不會自己結束任何一張單，結束由你決定（完成或移除）。
   */
  async schedule(): Promise<void> {
    if (this.deps.paused) return;
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduleRequested = false;
        await this.startQueued();
        this.deps.onChange();
      } while (this.rescheduleRequested);
    } finally {
      this.scheduling = false;
    }
  }

  private async startQueued(): Promise<void> {
    const settings = this.deps.settings();
    const items = this.deps.store.listWorkItems();
    const occupiedBy = new Map(items.filter((i) => i.folder && OCCUPYING.includes(i.status)).map((i) => [i.folder!, i]));
    const blockedProjects = new Set<string>();
    for (const next of items.filter((i) => i.status === 'queued')) {
      // 同一個專案照順序：前面那張還拿不到資料夾，後面的也先等
      if (blockedProjects.has(next.project)) continue;
      const rule = settings.projects[next.project];
      if (!rule) {
        this.update(next.id, { status: 'blocked', activity: `設定檔裡沒有「${next.project}」的規則` });
        continue;
      }
      const projectFolders = settings.folders.filter((f) => f.project === next.project);

      // 分支已經存在於某個資料夾：之前的提交只在那裡，一定要用那個資料夾
      const holding: string[] = [];
      for (const f of projectFolders) if (await localBranchExists(f.path, next.branch).catch(() => false)) holding.push(f.name);
      let onlyFolder: string | null = null;
      if (holding.length === 1) onlyFolder = holding[0];
      else if (holding.length > 1) {
        if (!next.preferredFolder || !holding.includes(next.preferredFolder)) {
          this.update(next.id, { status: 'blocked', activity: `分支在 ${holding.join('、')} 都有，請在計畫表選擇要用哪一個資料夾` });
          continue;
        }
        onlyFolder = next.preferredFolder;
      }

      // 每個資料夾不能用的原因：被哪張單佔住，或有未提交的修改（資料夾本來就在這條分支上的除外：那是之前做到一半的進度，準備時會問你）
      const reasons: string[] = [];
      const busy = new Set<string>();
      const branches: Record<string, string> = {};
      for (const f of projectFolders) {
        if (onlyFolder && f.name !== onlyFolder) continue;
        const owner = occupiedBy.get(f.name);
        if (owner) {
          busy.add(f.name);
          reasons.push(`${f.name} 正在做 ${owner.ticketKey}`);
          continue;
        }
        branches[f.name] = await currentBranch(f.path).catch(() => '');
        if (branches[f.name] === next.branch) continue;
        const dirty = await dirtyFiles(f.path).catch(() => ['（讀不到 git 狀態）']);
        if (dirty.length) {
          busy.add(f.name);
          reasons.push(`${f.name} 有未提交的修改（${dirty.slice(0, 2).join('、')}${dirty.length > 2 ? ' 等' : ''}）`);
        }
      }
      const folder = pickFolder(next, settings.folders, busy, branches, rule, onlyFolder);
      if (!folder) {
        blockedProjects.add(next.project);
        this.update(next.id, { activity: `排隊中：${reasons.join('；') || '等資料夾空出來'}` });
        continue;
      }
      occupiedBy.set(folder.name, next);
      this.update(next.id, { folder: folder.name, lane: 'development', status: 'preparing', activity: '準備資料夾' });
      void this.prepare(next.id);
    }
  }

  private folderPath(name: string): string {
    const folder = this.deps.settings().folders.find((f) => f.name === name);
    if (!folder) throw new Error(`設定檔裡沒有資料夾「${name}」`);
    if (!existsSync(folder.path)) throw new Error(`找不到資料夾「${name}」（${folder.path}），請檢查設定檔`);
    return folder.path;
  }

  /** 停下來問你；回答後從頭重新準備 */
  private ask(id: number, key: 'dirty' | 'diverged', question: string, continueLabel: string) {
    const item = this.update(id, {
      status: 'waiting',
      activity: question,
      pending: { kind: 'decision', requestId: key, question, options: [{ id: 'continue', label: continueLabel }, { id: 'stop', label: '先不要，停止這張單' }] },
    });
    this.notify(id, `${item.ticketKey} 要你決定`, question);
  }

  /**
   * 準備資料夾，然後啟動 AI：
   * - 分支不存在：從遠端最新的基底分支建立並切換（新開發）
   * - 分支已存在：切換過去繼續開發；只在遠端就從遠端建立本機分支
   * - 資料夾本來就在這條分支、而且有未提交的修改：先問你要不要接著做
   * - 本機落後遠端：快轉；本機和遠端各有新提交（分歧）：先問你
   */
  private async prepare(id: number): Promise<void> {
    const item = this.deps.store.getWorkItem(id)!;
    const cwd = this.folderPath(item.folder!);
    const allowed = this.allowed.get(id) ?? new Set();
    try {
      this.update(id, { activity: '抓遠端最新狀態' });
      await fetchOrigin(cwd);

      const here = await currentBranch(cwd);
      const remote = await remoteBranchExists(cwd, item.branch);
      let continuing = true;
      if (here === item.branch) {
        const dirty = await dirtyFiles(cwd);
        if (dirty.length && !allowed.has('dirty')) {
          return this.ask(id, 'dirty', `${item.folder} 已經在 ${item.branch}，有 ${dirty.length} 個未提交的修改（${dirty.slice(0, 3).join('、')}${dirty.length > 3 ? ' 等' : ''}）。要接著這些修改繼續開發嗎？`, '接著這些修改繼續開發');
        }
      } else {
        const dirty = await dirtyFiles(cwd);
        if (dirty.length) {
          this.update(id, {
            status: 'blocked',
            activity: `資料夾目前在 ${here || '（不在任何分支）'}，有未提交的修改（${dirty.slice(0, 3).join('、')}${dirty.length > 3 ? ` 等 ${dirty.length} 個` : ''}），請先處理後按「重試」`,
          });
          return;
        }
        const lockBefore = await fileHash(cwd, 'package-lock.json');
        if (await localBranchExists(cwd, item.branch)) {
          this.update(id, { activity: `切換到已存在的分支 ${item.branch}` });
          await switchBranch(cwd, item.branch);
        } else if (remote) {
          this.update(id, { activity: `從遠端切換到已存在的分支 ${item.branch}` });
          await switchToRemoteBranch(cwd, item.branch);
        } else {
          continuing = false;
          this.update(id, { activity: `從 origin/${item.baseBranch} 建立分支 ${item.branch}` });
          await createBranch(cwd, item.branch, item.baseBranch);
          await switchBranch(cwd, item.branch);
        }
        const lockAfter = await fileHash(cwd, 'package-lock.json');
        if (lockBefore !== lockAfter || !existsSync(join(cwd, 'node_modules'))) {
          this.update(id, { activity: '套件不同，安裝套件中（npm install，可能要幾分鐘）' });
          await shell(cwd, 'npm install', 20 * 60_000);
        }
      }

      if (remote && continuing) {
        const { ahead, behind } = await aheadBehind(cwd, item.branch);
        if (behind > 0 && ahead === 0) {
          this.update(id, { activity: `本機落後遠端 ${behind} 個提交，快轉到最新` });
          await fastForward(cwd, item.branch);
        } else if (behind > 0 && ahead > 0 && !allowed.has('diverged')) {
          return this.ask(id, 'diverged', `${item.branch} 的本機和遠端各有新的提交（本機多 ${ahead} 個、遠端多 ${behind} 個）。要用本機的版本繼續開發嗎？（不會動到遠端）`, '用本機版本繼續');
        }
      }

      // 基底有新的提交：開發前先 rebase 到最新（有沒提交的修改就先暫存、做完放回）。
      // 有衝突就停在 rebase 中，交給 AI 先解完再開發（使用者平常也是自己解）
      let rebase: { behind: number; conflict: boolean } | undefined;
      const behindBase = Number((await runGit(cwd, ['rev-list', '--count', `HEAD..origin/${item.baseBranch}`])).stdout.trim() || 0);
      if (continuing && behindBase > 0) {
        this.update(id, { activity: `基底 ${item.baseBranch} 有 ${behindBase} 個新提交，rebase 到最新` });
        const result = await runGit(cwd, ['-c', 'core.editor=true', 'rebase', '--autostash', `origin/${item.baseBranch}`], 120_000);
        const inProgress = existsSync(join(cwd, '.git', 'rebase-merge')) || existsSync(join(cwd, '.git', 'rebase-apply'));
        if (result.code !== 0 && !inProgress) throw new Error(`rebase 失敗：${result.stderr.trim().split('\n').slice(-2).join(' ')}`);
        rebase = { behind: behindBase, conflict: result.code !== 0 };
      }

      this.prepared.set(id, {
        rebase,
        continuing,
        commits: continuing ? await commitsSinceBase(cwd, item.baseBranch) : 0,
        dirty: (await dirtyFiles(cwd)).length,
      });
      await this.startAgent(id);
    } catch (error) {
      if (['removed', 'stopped'].includes(this.deps.store.getWorkItem(id)!.status)) return;
      this.update(id, { status: 'failed', activity: `準備失敗：${(error as Error).message}` });
      this.notify(id, `${item.ticketKey} 準備失敗`, (error as Error).message);
      void this.schedule();
    }
  }

  /** 回答準備階段的問題 */
  async decide(id: number, optionId: string) {
    const item = this.deps.store.getWorkItem(id)!;
    if (item.pending?.kind !== 'decision') throw new Error('目前沒有要你決定的事');
    if (optionId === 'stop') {
      this.allowed.delete(id);
      this.update(id, { status: 'stopped', activity: '你選擇先不要做這張單', pending: null });
      void this.schedule();
      return;
    }
    const allowed = this.allowed.get(id) ?? new Set();
    allowed.add(item.pending.requestId as 'dirty' | 'diverged');
    this.allowed.set(id, allowed);
    this.update(id, { status: 'preparing', activity: '繼續準備', pending: null });
    void this.prepare(id);
  }

  private async skillPath(name: string): Promise<string> {
    if (!this.skills?.some((s) => s.name === name)) {
      this.skills = await listSkills(this.deps.codex, this.deps.settings().folders[0]?.path ?? process.cwd());
    }
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) throw new Error(`Codex 找不到技能「${name}」`);
    return skill.path;
  }

  private async startAgent(id: number): Promise<void> {
    const { codex } = this.deps;
    const item = this.deps.store.getWorkItem(id)!;
    if (item.status === 'removed' || item.status === 'stopped') return; // 準備途中你移除或停止了
    const cwd = this.folderPath(item.folder!);
    await codex.start();
    this.update(id, { activity: '啟動 Codex' });
    // 一律開新的對話：單離開工作台就不留紀錄，不接回以前的對話（舊對話裡的舊指示會干擾）
    const config = threadConfig(this.deps.dataDir, this.deps.writeGuard, id, apiHosts(cwd));
    const thread = (
      await codex.request<{ thread: { id: string } }>(
        'thread/start',
        {
          cwd,
          // 每個指令都先問 FlowPilot，由 FlowPilot 決定自動同意或轉給你（見 policy.ts）
          approvalPolicy: 'untrusted',
          sandbox: 'danger-full-access',
          config,
        },
        180_000, // 第一次要下載瀏覽器工具，比較久
      )
    ).thread;
    this.update(id, { threadId: thread.id, status: 'running', stage: 'develop', activity: '開發中' });
    await codex.request('thread/name/set', { threadId: thread.id, name: `${item.ticketKey}｜${item.merchant ? `m${item.merchant}｜` : ''}${item.folder}` }).catch(() => {});

    const state: { continuing: boolean; commits: number; dirty: number; rebase?: { behind: number; conflict: boolean } } = this.prepared.get(id) ?? { continuing: false, commits: 0, dirty: 0 };
    this.prepared.delete(id);
    this.allowed.delete(id);
    const branchLine = state.continuing
      ? `- 這是已經存在的分支 ${item.branch}（基底 origin/${item.baseBranch}），之前已經有開發內容：比基底多 ${state.commits} 個提交、${state.dirty} 個未提交的修改。` +
        `請先看過現有的差異（git diff origin/${item.baseBranch}...HEAD 與 git status），了解做到哪裡，再接著完成剩下的部分；不要重做已經完成的內容，也不要丟掉未提交的修改。FlowPilot 已經切換好分支，不要切換分支。`
      : `- FlowPilot 已經在這個資料夾建立並切換到分支 ${item.branch}（從 origin/${item.baseBranch} 開出）。請直接在目前分支開發，不要切換分支。`;
    const skill = this.deps.settings().projects[item.project]?.devSkill ?? item.skill;
    const brief = reviewBrief(this.deps.store.getReview(item.ticketKey)?.review ?? null);
    const rebaseLine = !state.rebase
      ? ''
      : state.rebase.conflict
        ? `- 【先處理】FlowPilot 正在把分支 rebase 到最新的 origin/${item.baseBranch}（基底有 ${state.rebase.behind} 個新提交），遇到衝突停住了。請先解衝突：用 git status 看哪些檔案衝突，照兩邊的意圖合併好，git add 之後用 GIT_EDITOR=true git rebase --continue 繼續，直到 rebase 完成；不要 git rebase --abort。在回覆裡說明每個衝突怎麼解的。rebase 完成後再開始開發。`
        : `- FlowPilot 已經把分支 rebase 到最新的 origin/${item.baseBranch}（基底有 ${state.rebase.behind} 個新提交），沒有衝突。`;
    const instructions = [
      `請使用 $${skill} 處理這張 Jira：${item.mainUrl}`,
      rebaseLine,
      '',
      `- 指派給我的子任務是 ${item.ticketKey}（${item.ticketSummary}）；需求內容寫在主單 ${item.mainKey}。`,
      '- 需求以單上的「需求 / Requirements」與「預期結果 / Acceptance Criteria」為準，完成時要對照預期結果逐項確認；不理會「原始需求 / Merchant Requirements」。',
      brief ? '' : '- 這張單沒有開發前的審閱結果：請自己讀 Jira 單，整理成開發內容重點、牽涉頁面、後端API規格、預計執行內容、疑問五段之後再開發，不用要我先跑 jira-frontend-analysis。',
      branchLine,
      '- 這次只做開發：開發完 FlowPilot 會接著安排瀏覽器測試，你不用自己開瀏覽器測試。',
      // 提交時專案會跑 lint，開發時就先檢查，不要等到提交才冒出來（也不要 --fix，那會改到無關的檔案）
      '- 開發完跑一次跟提交時一樣的 lint，但只檢查這次改到的檔案，不要加 --fix 去動到其他檔案；有問題就修。',
      `- 不要修改 ${ENVIRONMENT_FILE}（SIT／UAT 由 FlowPilot 切換）。`,
      '- 不要提交、不要推送；完成後由我審查並提交。',
      '- 自己做，不要開子 AI（spawn_agent）分工。',
      item.targetMerchants.length ? `- 這張單之後還要移植到商戶 ${item.targetMerchants.join('、')}，那是下一階段的事，這次只做目前這個商戶。` : '',
      brief,
    ]
      .filter((line) => line !== '')
      .join('\n');
    const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', {
      threadId: thread.id,
      input: [
        { type: 'skill', name: skill, path: await this.skillPath(skill) },
        { type: 'text', text: instructions, text_elements: [] },
      ],
    });
    this.turns.set(thread.id, turn.id);
    // 不自動打開 VS Code：工作台就看得到對話與改動；需要時再按「在 VS Code 查看」
  }

  // ---- 瀏覽器測試 ----

  /**
   * 開始瀏覽器測試（同一段對話裡的新一輪）：
   * - 自動測試（開發完自動接著做）：無頭、不用你確認測試計畫、只做不改資料的操作、前端問題自己修正重測最多 3 次
   * - 重測（你按了才做）：有頭、先列測試計畫給你確認
   * 兩者都用測試帳號自動登入；網站由 FlowPilot 在資料夾終端機啟動；環境照資料夾目前的 environment.ts。
   */
  private async startTest(id: number, headed: boolean): Promise<void> {
    const { codex, settings: getSettings } = this.deps;
    const item = this.deps.store.getWorkItem(id)!;
    const settings = getSettings();
    const rule = settings.projects[item.project];
    const label = headed ? '重測' : '自動測試';
    this.update(id, { stage: headed ? 'retest' : 'autotest', status: 'running', activity: '準備瀏覽器測試：啟動本機網站', pending: null });
    try {
      if (!item.threadId || !item.folder) throw new Error('這張單還沒有 AI 對話');
      const cwd = this.folderPath(item.folder);
      const env = readEnvironment(cwd);
      if (env === null) throw new Error(`${ENVIRONMENT_FILE} 裡找不到 SIT／UAT 的標記`);
      if (env === 'mixed') throw new Error(`${ENVIRONMENT_FILE} 的 SIT、UAT 兩組都開著或都註解掉了，請在右邊「測試」選一個環境`);
      const account = resolveAccount(settings.testConfigDir, item.project, item.merchant, env);
      const where = `${item.project}${item.merchant ? ` m${item.merchant}` : ''} 的 ${env.toUpperCase()}`;
      if (!account) throw new Error(`帳號檔裡沒有 ${where} 的測試帳號，請在 ${configFile(settings.testConfigDir, item.project)} 補上`);
      // 先確認連得到後端：沒開 VPN 時馬上告訴你，不用等 AI 試好幾分鐘
      const apiUrl = readApiUrl(cwd);
      if (apiUrl && !(await (this.deps.canReach ?? reachable)(apiUrl))) {
        throw new Error(`連不到 ${env.toUpperCase()} 的後端（${apiUrl}），VPN 有開嗎？開了之後按「開瀏覽器測給我看」再測`);
      }
      if (!account.password) throw new Error(`${where} 的測試帳號 ${account.username} 還沒有密碼，請在 ${configFile(settings.testConfigDir, item.project)} 補上`);
      const url = await this.deps.ensureSite(item.folder);
      const accountFile = writeAccountFile(join(this.deps.dataDir, '測試帳號'), id, { project: item.project, merchant: item.merchant, environment: env, url, account });
      const requestLog = requestLogFile(this.deps.dataDir, id);
      mkdirSync(dirname(requestLog), { recursive: true });
      writeFileSync(requestLog, ''); // 每次測試從空的紀錄開始
      const common = [
        `- 寫入防護：這個測試瀏覽器會擋下所有會新增、修改、刪除資料的請求（PUT、PATCH、DELETE，以及網址看起來會改資料的 POST），不會送到後端，並回一個假的成功（success: true）。登入和查詢會正常放行。`,
        `  每個被擋下或放行的請求（含送出的內容）都記在 ${requestLog}，一行一筆 JSON。按下儲存、送出之後，用終端機讀這個檔案（例如 cat），逐欄對照預期的 payload（欄位、值、不該送的欄位、null）。`,
        '  因為回的是假的成功，存檔之後的畫面（例如列表多一筆、詳情變成新的值）不會跟真的一樣，這部分列進要我手動測的項目。不要用任何方式繞過防護（例如用 curl 或腳本直接打後端）。',
        `- 本機網站已經由 FlowPilot 啟動：${url}，直接用；不要自己啟動、重啟或關掉網站。`,
        `- 環境：FlowPilot 已經切到 ${env.toUpperCase()}，不要修改 ${ENVIRONMENT_FILE}。`,
        // 實測：AI 曾試著在瀏覽器裡讀這個檔案（讀不到）就放棄登入，所以寫清楚用終端機讀
        `- 登入：先用終端機指令讀 ${accountFile}（例如 cat）取得帳號密碼，再用瀏覽器工具填進登入表單自動登入（登入畫面要 OTP 時，填檔案裡的 otp）。這個檔案在電腦上，瀏覽器裡讀不到，不要在瀏覽器裡讀。不要停下來等我登入，也不要把密碼印出來或寫進任何檔案、回覆。`,
        '- 第一步先登入：登入失敗（帳號密碼錯、OTP、被擋）就立刻停止，不要再試別的，直接回報「測試結果：沒測成（登入失敗：原因）」。',
        '- 失敗時先判斷原因：是前端程式的問題就直接修正，然後重測失敗的部分，最多 3 輪；不是前端的問題（後端、資料、權限、環境）就記下來，不要修。API 回 404 通常是後端還沒部署這支 API，不是前端的錯。',
        '- 不要提交、不要推送。自己做，不要開子 AI（spawn_agent）分工。',
        ...designCompareLines(this.deps.store.getReview(item.ticketKey)?.review ?? null),
        ...reportLines(this.deps.store.getReview(item.ticketKey)?.review ?? null),
        '- 回覆的最後一行一定要照這個格式寫結果（FlowPilot 會讀這一行）：「測試結果：通過」、「測試結果：部分通過（原因）」或「測試結果：沒測成（原因）」。主要功能一個都沒測到（例如登入失敗、網站打不開）就是「沒測成」；有測到但有些項目沒測或沒過是「部分通過」。',
      ];
      const text = headed
        ? [
            `請使用 $${rule.testSkill} 開瀏覽器重新測試給我看（我手動測過，也可能請你改過了）。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
            '',
            `- 這次是有頭模式：只能用 ${HEADED_BROWSER} 這個瀏覽器工具（會開出視窗讓我看）；不要用 ${HEADLESS_BROWSER}，也不要另外寫 Playwright 腳本開瀏覽器。`,
            '- 先列出測試計畫（要測的頁面、操作、預期的 API），等我確認後才開始。重點放在我在這段對話裡要求修改的部分，再加上這張單的主要流程。',
            '- 新增、儲存這類操作可以直接做，不用每一步問我：寫入一律會被擋下（見下面），資料不會寫進後端。',
            ...common,
          ]
        : [
            `請使用 $${rule.testSkill} 測試剛才完成的開發（這是開發完 FlowPilot 自動安排的測試，只是先幫我抓明顯的錯，我之後一定會自己手動測）。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
            '',
            `- 我已經授權這次用無頭模式：只能用 ${HEADLESS_BROWSER} 這個瀏覽器工具（不會開出視窗）；不要用 ${HEADED_BROWSER}，也不要另外寫 Playwright 腳本開有頭的瀏覽器。`,
            '- 不用先給我確認測試計畫：列出測試案例後直接開始測，中途也不要停下來問我。',
            '- 新增、編輯、儲存的流程也要測（這通常是最容易出錯的地方）：寫入一律會被擋下（見下面），不用跳過，也不用問我。',
            ...common,
            '- 最後照技能的結果格式回報，並另外列出「跳過、要你手動測的項目」。',
          ];
      await codex.start();
      const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', {
        threadId: item.threadId,
        input: [
          { type: 'skill', name: rule.testSkill, path: await this.skillPath(rule.testSkill) },
          { type: 'text', text: text.join('\n'), text_elements: [] },
        ],
      });
      this.turns.set(item.threadId, turn.id);
      this.update(id, { activity: headed ? '列測試計畫給你確認' : '自動測試中（無頭）', ...(headed ? {} : { autotested: true }) });
    } catch (error) {
      if (['removed', 'stopped'].includes(this.deps.store.getWorkItem(id)!.status)) return;
      const message = `${label}沒辦法開始：${(error as Error).message}`;
      // 自動測試沒開始成，也算沒測成（不會再顯示成打勾或略過）
      const result = headed ? {} : { autotestResult: { kind: 'failed' as const, reason: (error as Error).message } };
      this.update(id, { stage: 'manual', status: 'waiting', activity: message, ...result });
      this.notify(id, `${item.ticketKey} ${label}沒辦法開始`, (error as Error).message);
    }
  }

  /**
   * AI 自我審查（檢查計畫要做時）：對照需求分析與團隊慣例，看一次自己的改動，有問題直接修。
   * 開始不了就直接進自動測試，不擋流程。
   */
  private async startSelfCheck(id: number): Promise<void> {
    const item = this.deps.store.getWorkItem(id)!;
    try {
      if (!item.threadId) throw new Error('沒有 AI 對話');
      this.update(id, { stage: 'selfcheck', status: 'running', activity: 'AI 自我審查中', pending: null });
      const text = [
        '## 自我審查',
        '',
        `請審查你這次的改動（git diff origin/${item.baseBranch}...HEAD，以及還沒提交的修改），發現問題就直接修正：`,
        '- 對照上面需求分析的「預期結果」：每一條都有做到嗎？有沒有做了需求沒要的東西？',
        '- 團隊慣例：多語系的文字有沒有都加到翻譯檔、有沒有重複的程式、命名和既有的寫法一不一致、錯誤處理和型別有沒有漏。',
        '- 跑跟提交時一樣的 lint，但只檢查這次改到的檔案，而且不要加 --fix 去動到其他檔案。',
        `- 不要提交、不要推送，不要修改 ${ENVIRONMENT_FILE}。自己做，不要開子 AI（spawn_agent）分工。`,
        '最後簡短列出：審查了什麼、修正了什麼、還有什麼風險。',
      ].join('\n');
      await this.deps.codex.start();
      const { turn } = await this.deps.codex.request<{ turn: { id: string } }>('turn/start', { threadId: item.threadId, input: [{ type: 'text', text, text_elements: [] }] });
      this.turns.set(item.threadId, turn.id);
    } catch (error) {
      this.deps.log(`${item.ticketKey} 自我審查開始不了，直接進自動測試：${(error as Error).message}`);
      await this.startTest(id, false);
    }
  }

  /** 開瀏覽器測給我看（你按了才做） */
  async retest(id: number) {
    this.assertIdle(id, '重測');
    await this.startTest(id, true);
  }

  /** 重跑自動測試（無頭）：上次沒測成（例如登入失敗、沒開 VPN）處理好之後用 */
  async rerunAutotest(id: number) {
    this.assertIdle(id, '重跑自動測試');
    await this.startTest(id, false);
  }

  private assertIdle(id: number, what: string) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId) throw new Error('這張單還沒有 AI 對話');
    if (this.turns.has(item.threadId) || item.status === 'running' || item.status === 'preparing') throw new Error(`AI 還在執行，請等它停下來（或中斷）再${what}`);
    if (item.pending) throw new Error(`AI 有事在等你回答，先處理再${what}`);
  }

  /** 勾選或取消手動測試清單的一項 */
  setManualDone(id: number, index: number, done: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.testReport?.manual[index]) throw new Error('找不到這個手動測試項目');
    const manual = item.testReport.manual.map((m, i) => (i === index ? { ...m, done } : m));
    this.update(id, { testReport: { ...item.testReport, manual } });
  }

  /** 試登一次要用的東西：網站網址、環境、這次的登入資料檔（沒辦法試就丟出原因） */
  async prepareTrialLogin(id: number): Promise<{ url: string; env: Env; accountFile: string; username: string; hosts: string[] }> {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error('這張單還沒有分配資料夾');
    const settings = this.deps.settings();
    const cwd = this.folderPath(item.folder);
    const env = readEnvironment(cwd);
    if (env !== 'sit' && env !== 'uat') throw new Error(`${ENVIRONMENT_FILE} 的環境看不出來，請先在上面選 SIT 或 UAT`);
    const account = resolveAccount(settings.testConfigDir, item.project, item.merchant, env);
    if (!account) throw new Error(`帳號檔裡沒有 ${env.toUpperCase()} 的帳號`);
    if (!account.password) throw new Error(`${account.username} 還沒有密碼`);
    const apiUrl = readApiUrl(cwd);
    if (apiUrl && !(await (this.deps.canReach ?? reachable)(apiUrl))) throw new Error(`連不到 ${env.toUpperCase()} 的後端（${apiUrl}），VPN 有開嗎？`);
    const url = await this.deps.ensureSite(item.folder);
    const accountFile = writeAccountFile(join(this.deps.dataDir, '測試帳號'), id, { project: item.project, merchant: item.merchant, environment: env, url, account });
    return { url, env, accountFile, username: account.username, hosts: apiHosts(cwd) };
  }

  /** 工作台右邊「測試」區塊：目前的環境、會用哪個帳號（不含密碼） */
  testState(id: number): TestState {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error('這張單還沒有分配資料夾');
    const settings = this.deps.settings();
    const environment = readEnvironment(this.folderPath(item.folder));
    const account = environment === 'sit' || environment === 'uat' ? resolveAccount(settings.testConfigDir, item.project, item.merchant, environment) : null;
    return { environment, account: account ? { username: account.username, hasPassword: !!account.password } : null, accountFile: configFile(settings.testConfigDir, item.project) };
  }

  /** 切換 SIT／UAT：只切換 environment.ts 裡的註解 */
  switchEnvironment(id: number, env: Env): TestState {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error('這張單還沒有分配資料夾');
    if (item.status === 'running' && (item.stage === 'autotest' || item.stage === 'retest')) throw new Error('瀏覽器測試進行中，切換環境會影響測試，請等它停下來（或中斷）');
    setEnvironment(this.folderPath(item.folder), env);
    return this.testState(id);
  }


  // ---- Codex 訊息 ----

  private async handle(message: RpcMessage): Promise<void> {
    const threadId: string | undefined = message.params?.threadId;
    if (!threadId) return;
    const own = this.deps.store.findWorkItemByThread(threadId);
    // AI 開的子 AI：用另一個對話編號，只處理它要我們回答的事（同意、提問），其他事件不算這張單的進度
    const parentId = own ? null : this.childThreads.get(threadId);
    const item = own ?? (parentId !== undefined && parentId !== null ? this.deps.store.getWorkItem(parentId) : null);
    if (!item || item.status === 'removed') return;
    if (!own && message.id === undefined) return;
    const method = message.method!;
    if (own) this.rememberChildThreads(item.id, threadId, message.params);

    // Codex 問我們的事
    if (message.id !== undefined) {
      if (APPROVAL_METHODS.test(method)) return this.onApproval(item, message);
      if (method === 'item/tool/requestUserInput') {
        const questions = (message.params.questions ?? []).map((q: any) => ({
          id: q.id,
          header: q.header ?? '',
          question: q.question ?? '',
          options: (q.options ?? []).map((o: any) => o.label ?? String(o)),
        }));
        this.update(item.id, { status: 'waiting', activity: 'AI 在問你問題', pending: { kind: 'userInput', requestId: message.id, questions } });
        this.notify(item.id, `${item.ticketKey} 在等你回答`, short(questions.map((q: any) => q.question).join('；')));
        return;
      }
      if (method === 'mcpServer/elicitation/request') return this.onElicitation(item, message);
      // 其他不認得的請求：記下來並拒絕，不要默默回空結果
      this.deps.log(`${item.ticketKey} 收到不認得的請求 ${method}：${JSON.stringify(message.params).slice(0, 300)}`);
      this.deps.codex.reply(message.id, { decision: 'decline' });
      return;
    }

    this.forwardChat(item.id, method, message.params);

    switch (method) {
      case 'turn/started':
        this.turns.set(threadId, message.params.turn?.id);
        if (item.status !== 'running') this.update(item.id, { status: 'running', activity: '執行中', pending: null });
        break;
      case 'item/agentMessage/delta': {
        const text = (this.streaming.get(item.id) ?? '') + (message.params.delta ?? '');
        this.streaming.set(item.id, text);
        this.deps.onStream(item.id, text);
        break;
      }
      case 'item/started': {
        const it = message.params.item ?? {};
        if (it.type === 'agentMessage') {
          this.streaming.set(item.id, '');
          this.deps.onStream(item.id, '');
        }
        const activity =
          it.type === 'commandExecution' ? `執行：${short(it.command ?? '', 80)}`
          : it.type === 'fileChange' ? '修改檔案'
          : it.type === 'reasoning' ? '思考中'
          : it.type === 'mcpToolCall' ? `使用工具：${it.server ?? ''} ${it.tool ?? ''}`
          : it.type === 'webSearch' ? '搜尋資料'
          : null;
        if (activity) this.update(item.id, { activity });
        break;
      }
      case 'item/completed':
        if (message.params.item?.type === 'agentMessage') {
          this.streaming.delete(item.id);
          this.update(item.id, { lastMessage: message.params.item.text ?? '' });
        }
        break;
      case 'serverRequest/resolved':
        // 你在 VS Code 那邊回覆了：清掉 FlowPilot 這邊的待處理
        if (item.pending && String(item.pending.requestId) === String(message.params.requestId)) {
          this.update(item.id, { status: 'running', activity: '已在 VS Code 回覆，繼續執行', pending: null });
        }
        break;
      case 'turn/completed': {
        this.turns.delete(threadId);
        this.streaming.delete(item.id);
        const turn = message.params.turn ?? {};
        const latest = this.deps.store.getWorkItem(item.id)!;
        if (turn.status === 'failed') {
          this.update(item.id, { status: 'failed', activity: `AI 失敗：${turn.error?.message ?? '原因不明'}`, pending: null });
          this.notify(item.id, `${item.ticketKey} 失敗`, turn.error?.message ?? '');
          void this.schedule();
        } else if (turn.status === 'interrupted') {
          if (latest.status !== 'stopped') this.update(item.id, { status: 'waiting', activity: '這一輪被中斷了，可以補充指示讓它繼續', pending: null });
        } else if (looksLikeQuestion(latest.lastMessage)) {
          this.update(item.id, { status: 'waiting', activity: 'AI 在問你問題', pending: null });
          this.notify(item.id, `${item.ticketKey} 在等你回答`, short(latest.lastMessage.slice(-200)));
        } else if (latest.stage === 'develop') {
          // 開發完：檢查計畫要自我審查就先審查，否則直接做無頭測試
          if (this.deps.store.getReview(latest.ticketKey)?.review.checks?.codeReview.need) void this.startSelfCheck(item.id);
          else void this.startTest(item.id, false);
        } else if (latest.stage === 'selfcheck') {
          void this.startTest(item.id, false);
        } else {
          let activity = STAGE_DONE[latest.stage] ?? '等你測試';
          const tested: { autotestResult?: TestResult; testReport?: TestReport } = {};
          if (latest.stage === 'autotest' || latest.stage === 'retest') {
            const result = parseTestResult(latest.lastMessage);
            const report = parseTestReport(latest.lastMessage, latest.testReport);
            if (report) tested.testReport = report;
            activity = testActivity(latest.stage === 'autotest' ? '自動測試' : '重測', result);
            if (latest.stage === 'autotest') tested.autotestResult = result;
          }
          this.update(item.id, { status: 'review', stage: 'manual', activity, pending: null, ...tested });
          this.notify(item.id, `${item.ticketKey} ${activity}`, short(latest.lastMessage.slice(-200)));
        }
        break;
      }
    }
  }

  /** 主對話的事件裡出現別的對話編號（開子 AI 時會帶），記下來屬於這張單 */
  private rememberChildThreads(itemId: number, ownThread: string, params: unknown) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const visit = (value: unknown, key: string, depth: number) => {
      if (depth > 6 || value === null || value === undefined) return;
      if (typeof value === 'string') {
        if (/thread/i.test(key) && UUID.test(value) && value !== ownThread) this.childThreads.set(value, itemId);
        return;
      }
      if (Array.isArray(value)) return value.forEach((v) => visit(v, key, depth + 1));
      if (typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
    };
    visit((params as { item?: unknown })?.item, '', 0);
  }

  /**
   * MCP 伺服器要確認的事（例如呼叫工具前的同意）：
   * 不需要填任何欄位的，直接同意；要填資料或要開網址的，轉給你決定。
   */
  private onElicitation(item: StoredWorkItem, message: RpcMessage) {
    const params = message.params ?? {};
    const fields = Object.keys(params.requestedSchema?.properties ?? {});
    if (params.mode !== 'url' && fields.length === 0) {
      this.deps.codex.reply(message.id!, { action: 'accept', content: {}, _meta: null });
      return;
    }
    const detail = params.mode === 'url' ? `${params.message ?? ''}（${params.url}）` : `${params.message ?? ''}（需要填：${fields.join('、')}）`;
    const pending: PendingRequest = { kind: 'approval', requestId: message.id!, method: message.method!, command: `${params.serverName}：${detail}`, reason: `${params.serverName} 要你確認` };
    this.update(item.id, { status: 'waiting', activity: `等你確認：${params.serverName}`, pending });
    this.notify(item.id, `${item.ticketKey} 要你確認`, `${params.serverName}：${short(params.message ?? '', 80)}`);
  }

  /** 把 Codex 的事件轉成聊天畫面的即時更新 */
  private forwardChat(itemId: number, method: string, params: any) {
    const emit = this.deps.onChat;
    if (!emit) return;
    if (method === 'item/started' || method === 'item/completed') {
      const entry = toEntry(params.item, Date.now());
      if (entry) emit(itemId, { type: 'upsert', entry });
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
      emit(itemId, { type: 'delta', id: params.itemId, field: 'text', delta: params.delta ?? '' });
    } else if (method === 'item/commandExecution/outputDelta') {
      emit(itemId, { type: 'delta', id: params.itemId, field: 'output', delta: params.delta ?? '' });
    }
  }

  private onApproval(item: StoredWorkItem, message: RpcMessage) {
    const params = message.params ?? {};
    const command: string = params.command ?? (Array.isArray(params.command) ? params.command.join(' ') : '');
    const isFileChange = /fileChange|applyPatch/.test(message.method!);
    const policy = isFileChange ? { ask: false, reason: '' } : commandPolicy(command);
    if (!policy.ask) {
      this.deps.codex.reply(message.id!, { decision: 'accept' });
      return;
    }
    const pending: PendingRequest = { kind: 'approval', requestId: message.id!, method: message.method!, command, reason: policy.reason };
    this.update(item.id, { status: 'waiting', activity: `等你同意：${policy.reason}`, pending });
    this.notify(item.id, `${item.ticketKey} 要執行危險指令`, `${policy.reason}：${short(command, 80)}`);
  }

  // ---- 你的操作 ----

  async approve(id: number, accept: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (item.pending?.kind !== 'approval') throw new Error('目前沒有等你同意的指令');
    this.deps.codex.reply(
      item.pending.requestId,
      item.pending.method === 'mcpServer/elicitation/request' ? { action: accept ? 'accept' : 'decline', content: accept ? {} : null, _meta: null } : { decision: accept ? 'accept' : 'decline' },
    );
    this.update(id, { status: 'running', activity: accept ? '已同意，繼續執行' : '已拒絕，繼續執行', pending: null });
  }

  /** asFix 為 false 時不當成「要求修改」（例如更新需求），做完說明不會寫「改好了」 */
  async reply(id: number, text: string, images: string[] = [], options: { asFix?: boolean; activity?: string } = {}) {
    const { codex } = this.deps;
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId) throw new Error('這張單還沒有 AI 對話');
    await codex.start();
    if (item.pending?.kind === 'userInput') {
      // 只有一題就直接當答案；好幾題時整段文字都交給每一題
      const answers = Object.fromEntries(item.pending.questions.map((q) => [q.id, { answers: [text] }]));
      codex.reply(item.pending.requestId, { answers });
      this.update(id, { status: 'running', activity: '已回答，繼續執行', pending: null });
      return;
    }
    const input: object[] = [
      ...(text.trim() ? [{ type: 'text', text, text_elements: [] }] : []),
      ...images.map((path) => ({ type: 'localImage', path })),
    ];
    if (input.length === 0) throw new Error('訊息是空的');
    const turnId = this.turns.get(item.threadId);
    if (turnId) {
      await codex.request('turn/steer', { threadId: item.threadId, input, expectedTurnId: turnId });
    } else {
      const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', { threadId: item.threadId, input });
      this.turns.set(item.threadId, turn.id);
    }
    // 等你測試時你在對話裡說的話，當成要求修改；改完回到等你測試（不會再自動測試，要重測按「開瀏覽器測給我看」）
    const stage = !turnId && item.stage === 'manual' && options.asFix !== false ? { stage: 'fix' as const } : {};
    this.update(id, { status: 'running', activity: options.activity ?? '已送出，繼續執行', pending: null, ...stage });
  }

  /** 中斷 AI 這一輪：單不停止，之後可以再補充指示讓它繼續 */
  async interrupt(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    if (!item.threadId || !turnId) throw new Error('AI 目前沒有在執行');
    await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId });
  }

  async stop(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    this.update(id, { status: 'stopped', activity: '你停止了這張單', pending: null });
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
    void this.schedule();
  }

  // ---- 完成 ----

  /**
   * 這張單做完了：讓出資料夾給下一張。
   * 資料夾要乾淨（提交或捨棄都可以）；environment.ts（瀏覽器測試切 SIT／UAT 用的）可以選擇直接還原。
   */
  async finish(id: number, restoreEnvironment: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (['running', 'preparing'].includes(item.status)) throw new Error('AI 還在執行，請先等它停下來（或中斷）');
    if (item.folder) {
      const cwd = this.folderPath(item.folder);
      if ((await currentBranch(cwd)) === item.branch) {
        let dirty = await dirtyFiles(cwd);
        if (restoreEnvironment) {
          for (const file of dirty.filter(isEnvironmentFile)) await runGit(cwd, ['restore', '--staged', '--worktree', '--', file]);
          dirty = await dirtyFiles(cwd);
        }
        if (dirty.length) throw new Error(`還有 ${dirty.length} 個未提交的修改（${dirty.slice(0, 3).join('、')}${dirty.length > 3 ? ' 等' : ''}），請先提交或捨棄`);
      }
    }
    const sha = item.folder ? (await runGit(this.folderPath(item.folder), ['rev-parse', '--short', 'HEAD'])).stdout.trim() : null;
    // 讓出資料夾時順便停掉本機網站（下一張單會自己重新啟動）
    if (item.folder) this.deps.stopSite?.(item.folder);
    this.update(id, {
      status: 'committed',
      lane: 'done',
      commitSha: sha,
      pending: null,
      activity:
        '已完成' +
        (item.targetMerchants.length ? `；之後要移植到 ${item.targetMerchants.map((m) => `m${m}`).join('、')}（移植功能還在開發中）` : ''),
    });
    await this.schedule();
  }

  /** 審閱紀錄跟著工作台走：這張單沒有別的列還在工作台上，就刪掉審閱紀錄 */
  private forgetReview(ticketKey: string) {
    if (!this.deps.store.hasActiveTicket(ticketKey)) this.deps.store.deleteReview(ticketKey);
  }

  /** 移除前查分支的狀況，讓你決定要不要一起刪；還沒分到資料夾的回傳 null */
  async branchInfo(id: number): Promise<BranchInfo | null> {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) return null;
    const cwd = this.folderPath(item.folder);
    const exists = await localBranchExists(cwd, item.branch);
    const hasRemote = exists && (await remoteBranchExists(cwd, item.branch));
    // 只在這台電腦上的提交：遠端有這條分支就跟遠端比，沒有就跟基底比
    const against = hasRemote ? `refs/remotes/origin/${item.branch}` : `origin/${item.baseBranch}`;
    const counted = exists ? await runGit(cwd, ['rev-list', '--count', `${against}..refs/heads/${item.branch}`]) : null;
    const unpushed = !exists ? 0 : counted!.code === 0 ? Number(counted!.stdout.trim()) : null;
    const onBranch = (await currentBranch(cwd)) === item.branch;
    const dirty = onBranch ? (await dirtyFiles(cwd)).filter((f) => !isEnvironmentFile(f)) : [];
    return { branch: item.branch, folder: item.folder, baseBranch: item.baseBranch, exists, hasRemote, unpushed, dirty };
  }

  /**
   * 刪掉這張單的本機分支（只刪本機，絕對不動遠端）：
   * 資料夾停在這條分支上時，先還原 environment.ts、切回基底分支再刪；有其他沒提交的修改就不刪，回傳原因。
   */
  private async deleteLocalBranch(item: StoredWorkItem): Promise<RemoveResult> {
    const info = await this.branchInfo(item.id);
    if (!info?.exists) return { branchDeleted: false, reason: '本機沒有這條分支' };
    const cwd = this.folderPath(item.folder!);
    // 資料夾停在這條分支上：還原成原本的樣子（丟掉沒提交的改動、切回基底）；
    // 資料夾已經換到別的分支（在做別張單）：只刪分支，不碰資料夾裡的檔案
    if ((await currentBranch(cwd)) === item.branch) {
      await runGit(cwd, ['reset', '-q', '--', '.']);
      await runGit(cwd, ['checkout', '--', '.']);
      for (const path of (await runGit(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean)) {
        rmSync(join(cwd, path), { force: true });
      }
      if (await localBranchExists(cwd, item.baseBranch)) await switchBranch(cwd, item.baseBranch);
      else await switchToRemoteBranch(cwd, item.baseBranch);
    }
    const result = await runGit(cwd, ['branch', '-D', item.branch]);
    if (result.code !== 0) return { branchDeleted: false, reason: `刪除失敗：${result.stderr.trim()}` };
    this.deps.log(`${item.ticketKey}：移除時刪除 ${item.folder} 的本機分支 ${item.branch}（丟掉 ${info.dirty.length} 個沒提交的改動、${info.unpushed ?? '?'} 個沒推送的提交）`);
    return { branchDeleted: true };
  }

  /**
   * 從工作台移除（進行中、已完成都可以）：回到從沒做過的樣子。
   * 刪掉本機分支（資料夾停在這條分支上時，先丟掉沒提交的改動、切回基底）；遠端分支絕對不動，由你自己刪。
   * 也刪掉審閱紀錄，單列表上的標籤跟著消失。
   */
  async remove(id: number): Promise<RemoveResult> {
    const item = this.deps.store.getWorkItem(id)!;
    // 移除會刪本機分支、還原資料夾；AI 還在改檔案時會亂掉，要等它停下來
    if (['running', 'preparing'].includes(item.status)) throw new Error('AI 還在執行，請先中斷這一輪再移除');
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
    this.streaming.delete(id);
    this.allowed.delete(id);
    let result: RemoveResult = { branchDeleted: false };
    // 移除一律刪本機分支（遠端不動）；還沒分到資料夾的（排隊中）沒有分支要刪
    if (item.folder) {
      try {
        result = await this.deleteLocalBranch(item);
      } catch (error) {
        result = { branchDeleted: false, reason: `刪除失敗：${(error as Error).message}` };
      }
    }
    this.update(id, { status: 'removed', lane: 'done', activity: result.branchDeleted ? '你從看板移除了，也刪掉了本機分支' : '你從看板移除了', pending: null });
    this.forgetReview(item.ticketKey);
    void this.schedule();
    return result;
  }

  async retry(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!['blocked', 'failed', 'stopped'].includes(item.status)) throw new Error('只有卡住、失敗或停止的單可以重試');
    if (item.threadId) {
      // 已經有對話：接著原本的對話繼續
      this.update(id, { status: 'running', activity: '繼續執行' });
      await this.reply(id, '請從剛才中斷的地方繼續。');
      return;
    }
    this.allowed.delete(id);
    this.update(id, { status: 'queued', lane: 'waiting', folder: null, activity: '' });
    await this.schedule();
  }

  async openInVSCode(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId || !item.folder) throw new Error('這張單還沒開始執行');
    await this.deps.vscode.attach(this.deps.settings().folders, { threadId: item.threadId, folder: item.folder, ticketKey: item.ticketKey });
  }

  /** 啟動或重新連線後，重新訂閱還在進行中的對話，才收得到它們的進度 */
  async resubscribe(): Promise<void> {
    if (this.deps.paused) return;
    const active = this.deps.store.listWorkItems().filter((i) => i.threadId && ['running', 'waiting', 'review'].includes(i.status));
    if (active.length) await this.deps.codex.start();
    for (const item of active) {
      try {
        const { thread } = await this.deps.codex.request<{ thread: { status?: { type: string } } }>('thread/resume', { threadId: item.threadId, excludeTurns: true, config: threadConfig(this.deps.dataDir, this.deps.writeGuard, item.id, item.folder ? apiHosts(this.folderPath(item.folder)) : []) });
        if (item.status === 'running' && thread.status?.type === 'idle') {
          this.update(item.id, { status: 'waiting', activity: 'FlowPilot 重新啟動時這一輪已經結束，看一下最後的回覆', pending: null });
        }
      } catch (error) {
        this.deps.log(`重新訂閱 ${item.ticketKey} 失敗：${(error as Error).message}`);
      }
    }
    // 準備到一半被中斷的，重新準備
    for (const item of this.deps.store.listWorkItems().filter((i) => i.status === 'preparing')) void this.prepare(item.id);
    void this.schedule();
  }
}
