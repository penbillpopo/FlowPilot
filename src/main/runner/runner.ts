// 執行器：把確認好的計畫變成工作項目，分配資料夾、建立並切換分支、啟動 Codex 執行技能，
// 並追蹤每段對話的進度、提問與同意請求。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardState, PendingRequest, SkillInfo, TicketPlan } from '../../shared/types';
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
  switchBranch,
  switchToRemoteBranch,
} from '../git';
import { deriveBranches } from '../planner/rules';
import type { Settings } from '../settings';
import { OCCUPYING, type StoredWorkItem, type Store } from '../store';
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
  log: (message: string) => void;
}

const APPROVAL_METHODS = /requestApproval$|^execCommandApproval$|^applyPatchApproval$/;

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
    };
  }

  private update(id: number, patch: Parameters<Store['updateWorkItem']>[1]): StoredWorkItem {
    const item = this.deps.store.updateWorkItem(id, patch);
    this.deps.onChange();
    return item;
  }

  // ---- 開始執行 ----

  /** 把確認好的計畫變成工作項目並開始排程（多商戶只建立來源，目標之後移植） */
  startRun(runId: number) {
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
    store.createWorkItems(items);
    this.deps.onChange();
    void this.schedule();
  }

  /** 有空的資料夾就分給排隊中的工作項目 */
  async schedule(): Promise<void> {
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduleRequested = false;
        const settings = this.deps.settings();
        const items = this.deps.store.listWorkItems();
        const occupied = new Set(items.filter((i) => i.folder && OCCUPYING.includes(i.status)).map((i) => i.folder!));
        for (const item of items.filter((i) => i.status === 'queued')) {
          const rule = settings.projects[item.project];
          const candidates = settings.folders.filter((f) => f.project === item.project && !occupied.has(f.name));
          if (!rule || candidates.length === 0) continue;
          // 分支已經存在於某個資料夾：之前的提交只在那裡，一定要用那個資料夾
          const projectFolders = settings.folders.filter((f) => f.project === item.project);
          const holding: string[] = [];
          for (const f of projectFolders) if (await localBranchExists(f.path, item.branch).catch(() => false)) holding.push(f.name);
          let onlyFolder: string | null = null;
          if (holding.length === 1) onlyFolder = holding[0];
          else if (holding.length > 1) {
            if (!item.preferredFolder || !holding.includes(item.preferredFolder)) {
              this.update(item.id, { status: 'blocked', activity: `分支在 ${holding.join('、')} 都有，請在計畫表選擇要用哪一個資料夾` });
              continue;
            }
            onlyFolder = item.preferredFolder;
          }
          const branches: Record<string, string> = {};
          for (const f of candidates) branches[f.name] = await currentBranch(f.path).catch(() => '');
          const folder = pickFolder(item, settings.folders, occupied, branches, rule, onlyFolder);
          if (!folder) {
            if (onlyFolder) this.update(item.id, { activity: `分支在 ${onlyFolder}，等它空出來` });
            continue;
          }
          occupied.add(folder.name);
          this.update(item.id, { folder: folder.name, status: 'preparing', activity: '準備資料夾' });
          void this.prepare(item.id);
        }
      } while (this.rescheduleRequested);
    } finally {
      this.scheduling = false;
    }
  }

  private folderPath(name: string): string {
    const folder = this.deps.settings().folders.find((f) => f.name === name);
    if (!folder) throw new Error(`設定檔裡沒有資料夾「${name}」`);
    return folder.path;
  }

  /** 停下來問你；回答後從頭重新準備 */
  private ask(id: number, key: 'dirty' | 'diverged', question: string, continueLabel: string) {
    const item = this.update(id, {
      status: 'waiting',
      activity: question,
      pending: { kind: 'decision', requestId: key, question, options: [{ id: 'continue', label: continueLabel }, { id: 'stop', label: '先不要，停止這張單' }] },
    });
    this.deps.notify(`${item.ticketKey} 要你決定`, question, id);
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
      this.update(id, { status: 'failed', activity: `準備失敗：${(error as Error).message}` });
      this.deps.notify(`${item.ticketKey} 準備失敗`, (error as Error).message, id);
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
    const cwd = this.folderPath(item.folder!);
    await codex.start();
    this.update(id, { activity: '啟動 Codex' });
    const { thread } = await codex.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      // 每個指令都先問 FlowPilot，由 FlowPilot 決定自動同意或轉給你（見 policy.ts）
      approvalPolicy: 'untrusted',
      sandbox: 'danger-full-access',
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
    // 對話開始之後才接得上：叫 VS Code 開分頁
    void this.openInVSCode(id).catch((e) => this.deps.log(`打開 VS Code 失敗：${e.message}`));
  }

  // ---- Codex 訊息 ----

  private async handle(message: RpcMessage): Promise<void> {
    const threadId: string | undefined = message.params?.threadId;
    if (!threadId) return;
    const item = this.deps.store.findWorkItemByThread(threadId);
    if (!item) return;
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
        this.deps.notify(`${item.ticketKey} 在等你回答`, short(questions.map((q: any) => q.question).join('；')), item.id);
        return;
      }
      // 其他不認得的請求：回空結果，避免 AI 卡住
      this.deps.codex.reply(message.id, {});
      return;
    }

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
          this.deps.notify(`${item.ticketKey} 失敗`, turn.error?.message ?? '', item.id);
        } else if (turn.status === 'interrupted') {
          if (latest.status !== 'stopped') this.update(item.id, { status: 'waiting', activity: '這一輪被中斷了，可以補充指示讓它繼續', pending: null });
        } else if (looksLikeQuestion(latest.lastMessage)) {
          this.update(item.id, { status: 'waiting', activity: 'AI 在問你問題', pending: null });
          this.deps.notify(`${item.ticketKey} 在等你回答`, short(latest.lastMessage.slice(-200)), item.id);
        } else {
          this.update(item.id, { status: 'review', activity: 'AI 做完了，等你審查', pending: null });
          this.deps.notify(`${item.ticketKey} 做完了`, '等你審查', item.id);
        }
        break;
      }
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
    this.deps.notify(`${item.ticketKey} 要執行危險指令`, `${policy.reason}：${short(command, 80)}`, item.id);
  }

  // ---- 你的操作 ----

  async approve(id: number, accept: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (item.pending?.kind !== 'approval') throw new Error('目前沒有等你同意的指令');
    this.deps.codex.reply(item.pending.requestId, { decision: accept ? 'accept' : 'decline' });
    this.update(id, { status: 'running', activity: accept ? '已同意，繼續執行' : '已拒絕，繼續執行', pending: null });
  }

  async reply(id: number, text: string) {
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
    const input = [{ type: 'text', text, text_elements: [] }];
    const turnId = this.turns.get(item.threadId);
    if (turnId) {
      await codex.request('turn/steer', { threadId: item.threadId, input, expectedTurnId: turnId });
    } else {
      const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', { threadId: item.threadId, input });
      this.turns.set(item.threadId, turn.id);
    }
    this.update(id, { status: 'running', activity: '已送出，繼續執行', pending: null });
  }

  async stop(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    this.update(id, { status: 'stopped', activity: '你停止了這張單', pending: null });
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
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
    this.update(id, { status: 'queued', folder: null, activity: '' });
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
        const { thread } = await this.deps.codex.request<{ thread: { status?: { type: string } } }>('thread/resume', { threadId: item.threadId, excludeTurns: true });
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
