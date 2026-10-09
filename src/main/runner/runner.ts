// 執行器：把確認好的計畫變成工作項目，分配資料夾、建立並切換分支、啟動 Codex 執行技能，
// 並追蹤每段對話的進度、提問與同意請求。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardState, ChatEvent, PendingRequest, SkillInfo, TicketPlan } from '../../shared/types';
import { toEntry } from '../chat';
import { reviewBrief } from '../planner/review';
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
}

const APPROVAL_METHODS = /requestApproval$|^execCommandApproval$|^applyPatchApproval$/;

/**
 * 開發用對話的設定：關掉 Codex 內建的「控制電腦／瀏覽器」。
 * 實測：開著時 AI 會用它去開 Figma 網頁（在常駐服務裡用不了，就放棄），關掉後才會改用 Figma MCP。
 * 瀏覽器測試用的是 Playwright MCP，不受影響。
 */
const THREAD_CONFIG = { features: { computer_use: false, browser_use: false, browser_use_external: false } };

/** 瀏覽器測試技能切換 SIT／UAT 時會改的檔案 */
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
  /** 下一張為什麼還沒開始對話（顯示在看板上） */
  private nextBlockedReason: string | null = null;
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
      items: items.map(({ branchCreated: _, ...item }) => item),
      pendingRun: store.pendingPlannedRun(),
      streaming: Object.fromEntries(this.streaming),
      development: { max: this.deps.settings().maxInDevelopment, count: this.inDevelopment(items).length },
      nextBlockedReason: this.nextBlockedReason,
    };
  }

  /** 開發佇列裡還沒結束的單 */
  private inDevelopment(items = this.deps.store.listWorkItems()) {
    return items.filter((i) => i.lane === 'development' && !FINISHED.includes(i.status));
  }

  /** 只有「對話中」的單跳系統通知；開發佇列只在看板上標示，由你自己點進去看 */
  private notify(id: number, title: string, body: string) {
    if (this.deps.store.getWorkItem(id)?.lane === 'conversation') this.deps.notify(title, body, id);
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
          skill: plan.skill,
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
   * 排程：同一時間只跟一張單對話。
   * 沒有單在對話中時，照計畫順序取下一張排隊的單，分配資料夾、開始準備；
   * 下一張拿不到資料夾就停在原地（不跳過，維持順序），並在看板說明原因。
   */
  async schedule(): Promise<void> {
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduleRequested = false;
        await this.startNextConversation();
        this.deps.onChange();
      } while (this.rescheduleRequested);
    } finally {
      this.scheduling = false;
    }
  }

  private async startNextConversation(): Promise<void> {
    const settings = this.deps.settings();
    const items = this.deps.store.listWorkItems();
    const talking = items.find((i) => i.lane === 'conversation' && !FINISHED.includes(i.status));
    const next = items.find((i) => i.lane === 'waiting' && i.status === 'queued');
    if (talking || !next) {
      this.nextBlockedReason = null;
      return;
    }
    const rule = settings.projects[next.project];
    if (!rule) {
      this.update(next.id, { status: 'blocked', activity: `設定檔裡沒有「${next.project}」的規則` });
      return;
    }
    const occupiedBy = new Map(items.filter((i) => i.folder && OCCUPYING.includes(i.status)).map((i) => [i.folder!, i]));
    const projectFolders = settings.folders.filter((f) => f.project === next.project);

    // 分支已經存在於某個資料夾：之前的提交只在那裡，一定要用那個資料夾
    const holding: string[] = [];
    for (const f of projectFolders) if (await localBranchExists(f.path, next.branch).catch(() => false)) holding.push(f.name);
    let onlyFolder: string | null = null;
    if (holding.length === 1) onlyFolder = holding[0];
    else if (holding.length > 1) {
      if (!next.preferredFolder || !holding.includes(next.preferredFolder)) {
        this.update(next.id, { status: 'blocked', activity: `分支在 ${holding.join('、')} 都有，請在計畫表選擇要用哪一個資料夾` });
        return;
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
        reasons.push(`${f.name} 被 ${owner.ticketKey} 佔用`);
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
      this.nextBlockedReason = `下一張 ${next.ticketKey} 在等 ${next.project} 的資料夾：${reasons.join('；') || '沒有可用的資料夾'}`;
      this.update(next.id, { activity: `排隊中：${reasons.join('；') || '等資料夾空出來'}` });
      return;
    }
    this.nextBlockedReason = null;
    this.update(next.id, { folder: folder.name, lane: 'conversation', status: 'preparing', activity: '準備資料夾' });
    void this.prepare(next.id);
  }

  /** 對話中的單問完了：移到開發佇列，讓下一張進來對話（開發佇列有上限） */
  async handOff(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (item.lane !== 'conversation') throw new Error('只有對話中的單可以換下一張');
    const { maxInDevelopment } = this.deps.settings();
    const developing = this.inDevelopment();
    if (developing.length >= maxInDevelopment) {
      throw new Error(`開發佇列已滿（${developing.length}／${maxInDevelopment}）：請先審查提交、或移除一張（${developing.map((i) => i.ticketKey).join('、')}）`);
    }
    this.update(id, { lane: 'development' });
    await this.schedule();
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
    const { thread } = await codex.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      // 每個指令都先問 FlowPilot，由 FlowPilot 決定自動同意或轉給你（見 policy.ts）
      approvalPolicy: 'untrusted',
      sandbox: 'danger-full-access',
      config: THREAD_CONFIG,
    });
    this.update(id, { threadId: thread.id, status: 'running', activity: '執行技能' });
    await codex.request('thread/name/set', { threadId: thread.id, name: `${item.ticketKey}｜${item.merchant ? `m${item.merchant}｜` : ''}${item.folder}` }).catch(() => {});

    const state = this.prepared.get(id) ?? { continuing: false, commits: 0, dirty: 0 };
    this.prepared.delete(id);
    this.allowed.delete(id);
    const branchLine = state.continuing
      ? `- 這是已經存在的分支 ${item.branch}（基底 origin/${item.baseBranch}），之前已經有開發內容：比基底多 ${state.commits} 個提交、${state.dirty} 個未提交的修改。` +
        `請先看過現有的差異（git diff origin/${item.baseBranch}...HEAD 與 git status），了解做到哪裡，再接著完成剩下的部分；不要重做已經完成的內容，也不要丟掉未提交的修改。FlowPilot 已經切換好分支，不要切換分支。`
      : `- FlowPilot 已經在這個資料夾建立並切換到分支 ${item.branch}（從 origin/${item.baseBranch} 開出）。請直接在目前分支開發，不要切換分支。`;
    const instructions = [
      `請使用 $${item.skill} 處理這張 Jira：${item.mainUrl}`,
      '',
      `- 指派給我的子任務是 ${item.ticketKey}（${item.ticketSummary}）；需求內容寫在主單 ${item.mainKey}。`,
      branchLine,
      '- 不要提交、不要推送；完成後由我審查並提交。',
      item.targetMerchants.length ? `- 這張單之後還要移植到商戶 ${item.targetMerchants.join('、')}，那是下一階段的事，這次只做目前這個商戶。` : '',
      reviewBrief(this.deps.store.getReview(item.ticketKey)?.review ?? null),
    ]
      .filter((line) => line !== '')
      .join('\n');
    const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', {
      threadId: thread.id,
      input: [
        { type: 'skill', name: item.skill, path: await this.skillPath(item.skill) },
        { type: 'text', text: instructions, text_elements: [] },
      ],
    });
    this.turns.set(thread.id, turn.id);
    // 不自動打開 VS Code：工作台就看得到對話與改動；需要時再按「在 VS Code 查看」
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
        } else {
          this.update(item.id, { status: 'review', activity: 'AI 做完了，等你審查', pending: null });
          this.notify(item.id, `${item.ticketKey} 做完了`, '等你審查');
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
    this.update(id, { status: 'running', activity: '已送出，繼續執行', pending: null });
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

  /**
   * 從看板移除。執行中的會先中斷 AI 這一輪；準備中的，準備流程會在啟動 AI 前自己停下來。
   * 不會動到資料夾裡的檔案或分支。
   */
  async remove(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
    this.streaming.delete(id);
    this.allowed.delete(id);
    this.update(id, { status: 'removed', lane: 'done', activity: '你從看板移除了', pending: null });
    void this.schedule();
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
    this.update(id, { status: 'queued', lane: item.lane === 'development' ? 'waiting' : item.lane === 'conversation' ? 'waiting' : item.lane, folder: null, activity: '' });
    await this.schedule();
  }

  async openInVSCode(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId || !item.folder) throw new Error('這張單還沒開始執行');
    await this.deps.vscode.attach(this.deps.settings().folders, { threadId: item.threadId, folder: item.folder, ticketKey: item.ticketKey });
  }

  /** 啟動或重新連線後，重新訂閱還在進行中的對話，才收得到它們的進度 */
  async resubscribe(): Promise<void> {
    const active = this.deps.store.listWorkItems().filter((i) => i.threadId && ['running', 'waiting', 'review'].includes(i.status));
    if (active.length) await this.deps.codex.start();
    for (const item of active) {
      try {
        const { thread } = await this.deps.codex.request<{ thread: { status?: { type: string } } }>('thread/resume', { threadId: item.threadId, excludeTurns: true, config: THREAD_CONFIG });
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
