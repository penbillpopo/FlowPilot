// 執行器：把確認好的計畫變成工作項目，分配資料夾、建立並切換分支、啟動 Codex 執行技能，
// 並追蹤每段對話的進度、提問與同意請求。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BoardState, BranchInfo, ChatEvent, Env, RemoveResult, PendingRequest, SkillInfo, TestState, TicketPlan, WorkStage } from '../../shared/types';
import { toEntry } from '../chat';
import { ENVIRONMENT_FILE, readEnvironment, setEnvironment } from '../environment';
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
import { commandPolicy, looksLikeQuestion } from './policy';

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
}

const APPROVAL_METHODS = /requestApproval$|^execCommandApproval$|^applyPatchApproval$/;

/** 瀏覽器工具的名稱：自動測試用無頭的，重測用有頭的 */
const HEADLESS_BROWSER = 'flowpilot_browser_headless';
const HEADED_BROWSER = 'flowpilot_browser';

/**
 * 開發用對話的設定（只在 FlowPilot 開的對話裡生效，不改你的 ~/.codex/config.toml）：
 * - 關掉 Codex 內建的「控制電腦／瀏覽器」。實測：開著時 AI 會用它去開 Figma 網頁（在常駐服務裡用不了，就放棄），關掉後才會改用 Figma MCP。
 * - 瀏覽器測試改用 FlowPilot 提供的兩套 Playwright：無頭（自動測試）與有頭（重測給你看），
 *   截圖紀錄放在 FlowPilot 的資料夾，不會弄髒專案；你原本的 playwright 在這些對話裡關掉，AI 才不會用錯。
 */
function threadConfig(dataDir: string) {
  const outputDir = join(dataDir, '瀏覽器測試紀錄');
  const browser = (extra: string[]) => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest', ...extra, '--isolated', '--caps', 'devtools', '--output-dir', outputDir] });
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
  manual: '等你測試',
};

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
  /** AI 正在寫、還沒寫完的回覆（只放記憶體；寫完才存進資料庫） */
  private streaming = new Map<number, string>();
  /** 你在準備階段已經同意的事（接著未提交的修改做、用本機版本繼續） */
  private allowed = new Map<number, Set<'dirty' | 'diverged'>>();
  /** 準備好之後，交代給 AI 時要說明的現況 */
  private prepared = new Map<number, { continuing: boolean; commits: number; dirty: number }>();
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

      this.prepared.set(id, {
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
    const { thread } = await codex.request<{ thread: { id: string } }>(
      'thread/start',
      {
        cwd,
        // 每個指令都先問 FlowPilot，由 FlowPilot 決定自動同意或轉給你（見 policy.ts）
        approvalPolicy: 'untrusted',
        sandbox: 'danger-full-access',
        config: threadConfig(this.deps.dataDir),
      },
      180_000, // 第一次要下載瀏覽器工具，比較久
    );
    this.update(id, { threadId: thread.id, status: 'running', stage: 'develop', activity: '開發中' });
    await codex.request('thread/name/set', { threadId: thread.id, name: `${item.ticketKey}｜${item.merchant ? `m${item.merchant}｜` : ''}${item.folder}` }).catch(() => {});

    const state = this.prepared.get(id) ?? { continuing: false, commits: 0, dirty: 0 };
    this.prepared.delete(id);
    this.allowed.delete(id);
    const branchLine = state.continuing
      ? `- 這是已經存在的分支 ${item.branch}（基底 origin/${item.baseBranch}），之前已經有開發內容：比基底多 ${state.commits} 個提交、${state.dirty} 個未提交的修改。` +
        `請先看過現有的差異（git diff origin/${item.baseBranch}...HEAD 與 git status），了解做到哪裡，再接著完成剩下的部分；不要重做已經完成的內容，也不要丟掉未提交的修改。FlowPilot 已經切換好分支，不要切換分支。`
      : `- FlowPilot 已經在這個資料夾建立並切換到分支 ${item.branch}（從 origin/${item.baseBranch} 開出）。請直接在目前分支開發，不要切換分支。`;
    const skill = this.deps.settings().projects[item.project]?.devSkill ?? item.skill;
    const brief = reviewBrief(this.deps.store.getReview(item.ticketKey)?.review ?? null);
    const instructions = [
      `請使用 $${skill} 處理這張 Jira：${item.mainUrl}`,
      '',
      `- 指派給我的子任務是 ${item.ticketKey}（${item.ticketSummary}）；需求內容寫在主單 ${item.mainKey}。`,
      '- 需求以單上的「需求 / Requirements」與「預期結果 / Acceptance Criteria」為準，完成時要對照預期結果逐項確認；不理會「原始需求 / Merchant Requirements」。',
      brief ? '' : '- 這張單沒有開發前的審閱結果：請自己讀 Jira 單，整理成開發內容重點、牽涉頁面、後端API規格、預計執行內容、疑問五段之後再開發，不用要我先跑 jira-frontend-analysis。',
      branchLine,
      '- 這次只做開發：開發完 FlowPilot 會接著安排瀏覽器測試，你不用自己開瀏覽器測試。',
      `- 不要修改 ${ENVIRONMENT_FILE}（SIT／UAT 由 FlowPilot 切換）。`,
      '- 不要提交、不要推送；完成後由我審查並提交。',
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
      if (!account.password) throw new Error(`${where} 的測試帳號 ${account.username} 還沒有密碼，請在 ${configFile(settings.testConfigDir, item.project)} 補上`);
      const url = await this.deps.ensureSite(item.folder);
      const accountFile = writeAccountFile(join(this.deps.dataDir, '測試帳號'), id, { project: item.project, merchant: item.merchant, environment: env, url, account });
      const common = [
        `- 本機網站已經由 FlowPilot 啟動：${url}，直接用；不要自己啟動、重啟或關掉網站。`,
        `- 環境：FlowPilot 已經切到 ${env.toUpperCase()}，不要修改 ${ENVIRONMENT_FILE}。`,
        `- 登入：讀 ${accountFile} 裡的帳號密碼自動登入（登入畫面要 OTP 時，填檔案裡的 otp）。不要停下來等我登入，也不要把密碼印出來或寫進任何檔案、回覆。`,
        '- 失敗時先判斷原因：是前端程式的問題就直接修正，然後重測失敗的部分，最多 3 輪；不是前端的問題（後端、資料、權限、環境）就記下來，不要修。',
        '- 不要提交、不要推送。',
      ];
      const text = headed
        ? [
            `請使用 $${rule.testSkill} 開瀏覽器重新測試給我看（我手動測過，也可能請你改過了）。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
            '',
            `- 這次是有頭模式：只能用 ${HEADED_BROWSER} 這個瀏覽器工具（會開出視窗讓我看）；不要用 ${HEADLESS_BROWSER}，也不要另外寫 Playwright 腳本開瀏覽器。`,
            '- 先列出測試計畫（要測的頁面、操作、預期的 API），等我確認後才開始。重點放在我在這段對話裡要求修改的部分，再加上這張單的主要流程。',
            '- 會新增、修改、刪除資料的操作，照技能的規則，每一步做之前都要先問我。',
            ...common,
          ]
        : [
            `請使用 $${rule.testSkill} 測試剛才完成的開發（這是開發完 FlowPilot 自動安排的測試，只是先幫我抓明顯的錯，我之後一定會自己手動測）。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
            '',
            `- 我已經授權這次用無頭模式：只能用 ${HEADLESS_BROWSER} 這個瀏覽器工具（不會開出視窗）；不要用 ${HEADED_BROWSER}，也不要另外寫 Playwright 腳本開有頭的瀏覽器。`,
            '- 不用先給我確認測試計畫：列出測試案例後直接開始測，中途也不要停下來問我。',
            '- 只做不會新增、修改、刪除資料的操作（瀏覽、搜尋、篩選、看詳情、切換語言、匯出下載）；會新增或修改資料的步驟（新增、送出、儲存、核准、拒絕、刪除、狀態變更、資金相關…）一律跳過，在結果裡列出來給我手動測。',
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
      this.update(id, { stage: 'manual', status: 'waiting', activity: message });
      this.notify(id, `${item.ticketKey} ${label}沒辦法開始`, (error as Error).message);
    }
  }

  /** 開瀏覽器測給我看（你按了才做） */
  async retest(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId) throw new Error('這張單還沒有 AI 對話');
    if (this.turns.has(item.threadId) || item.status === 'running' || item.status === 'preparing') throw new Error('AI 還在執行，請等它停下來（或中斷）再重測');
    if (item.pending) throw new Error('AI 有事在等你回答，先處理再重測');
    await this.startTest(id, true);
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
    const item = this.deps.store.findWorkItemByThread(threadId);
    if (!item || item.status === 'removed') return;
    const method = message.method!;

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
          // 開發完自動接著做無頭測試
          void this.startTest(item.id, false);
        } else {
          const activity = STAGE_DONE[latest.stage] ?? '等你測試';
          this.update(item.id, { status: 'review', stage: 'manual', activity, pending: null });
          this.notify(item.id, `${item.ticketKey} ${activity}`, short(latest.lastMessage.slice(-200)));
        }
        break;
      }
    }
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

  async reply(id: number, text: string, images: string[] = []) {
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
    const stage = !turnId && item.stage === 'manual' ? { stage: 'fix' as const } : {};
    this.update(id, { status: 'running', activity: '已送出，繼續執行', pending: null, ...stage });
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
    if (info.dirty.length) {
      return { branchDeleted: false, reason: `資料夾還有 ${info.dirty.length} 個沒提交的修改（${info.dirty.slice(0, 3).join('、')}${info.dirty.length > 3 ? ' 等' : ''}），為了不丟掉它們，分支沒有刪` };
    }
    const cwd = this.folderPath(item.folder!);
    if ((await currentBranch(cwd)) === item.branch) {
      for (const file of (await dirtyFiles(cwd)).filter(isEnvironmentFile)) await runGit(cwd, ['restore', '--staged', '--worktree', '--', file]);
      if (await localBranchExists(cwd, item.baseBranch)) await switchBranch(cwd, item.baseBranch);
      else await switchToRemoteBranch(cwd, item.baseBranch);
    }
    const result = await runGit(cwd, ['branch', '-D', item.branch]);
    if (result.code !== 0) return { branchDeleted: false, reason: `刪除失敗：${result.stderr.trim()}` };
    this.deps.log(`${item.ticketKey}：刪除 ${item.folder} 的本機分支 ${item.branch}（${info.unpushed} 個只在本機的提交一起刪除）`);
    return { branchDeleted: true };
  }

  /**
   * 從看板移除。執行中的會先中斷 AI 這一輪；準備中的，準備流程會在啟動 AI 前自己停下來。
   * 預設不動資料夾裡的檔案或分支；deleteBranch 為 true 時順便刪掉本機分支（不動遠端）。
   */
  async remove(id: number, deleteBranch = false): Promise<RemoveResult> {
    const item = this.deps.store.getWorkItem(id)!;
    // AI 還在改檔案時刪分支會亂掉，要等它停下來
    if (deleteBranch && ['running', 'preparing'].includes(item.status)) throw new Error('AI 還在執行，請先中斷這一輪再移除並刪除分支');
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
    this.streaming.delete(id);
    this.allowed.delete(id);
    let result: RemoveResult = { branchDeleted: false };
    if (deleteBranch && item.folder) {
      try {
        result = await this.deleteLocalBranch(item);
      } catch (error) {
        result = { branchDeleted: false, reason: `刪除失敗：${(error as Error).message}` };
      }
    }
    this.update(id, { status: 'removed', lane: 'done', activity: result.branchDeleted ? '你從看板移除了，也刪掉了本機分支' : '你從看板移除了', pending: null });
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
        const { thread } = await this.deps.codex.request<{ thread: { status?: { type: string } } }>('thread/resume', { threadId: item.threadId, excludeTurns: true, config: threadConfig(this.deps.dataDir) });
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
