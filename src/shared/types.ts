// 主程序與畫面共用的資料型別

/** Jira 上一張指派給我的單（大多是 [FE] 子任務） */
export interface JiraTicket {
  /** 指派給我的那張單的單號，例如 ALL-14734（分支用這個） */
  key: string;
  summary: string;
  status: string;
  issueType: string;
  /** ISO 時間字串 */
  updated: string;
  url: string;
  /** 上層主單；被指派的本身就是主單時為 null */
  parent: { key: string; summary: string; url: string } | null;
}

/** 交給技能的 Jira 單：有主單用主單，沒有就用自己 */
export function mainTicketKey(ticket: JiraTicket): string {
  return ticket.parent?.key ?? ticket.key;
}

export interface RunSummary {
  id: number;
  createdAt: string;
  status: string;
  ticketKeys: string[];
}

/** 一張單要做在某個專案上（PlatformWeb 另外帶商戶） */
export interface PlanEntry {
  project: string;
  /** 只有有商戶的專案才有值 */
  merchants: number[];
  /** 多商戶時先開發的商戶；其他商戶之後用 platform-web-copy 移植 */
  sourceMerchant: number | null;
  /** AI 的判斷理由 */
  reason: string;
  /** 分支已經存在於好幾個資料夾時，你選要用哪一個 */
  folder?: string | null;
}

/** 一張單的計畫（計畫表的一列） */
export interface TicketPlan {
  ticket: JiraTicket;
  entries: PlanEntry[];
  skill: string;
  /** 合併請求標題，也是提交訊息：feat(ALL-xxxxx) 英文描述 */
  prTitle: string;
  /** AI 的整體說明 */
  reason: string;
}

export type BranchRole = 'single' | 'source' | 'target';

/** 由計畫算出來的一條分支 */
export interface PlanBranch {
  ticketKey: string;
  project: string;
  merchant: number | null;
  role: BranchRole;
  branch: string;
  baseBranch: string;
  /** 已經存在的位置（資料夾名稱或「遠端」）；空陣列代表還沒建立 */
  existsIn: string[];
}

/** AI 判斷的結果（還沒經過你修改） */
export interface Judgement {
  entries: PlanEntry[];
  prTitle: string;
  reason: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export type WorkStatus =
  | 'queued' // 排隊中：等資料夾空出來
  | 'preparing' // 準備中：抓遠端、建立並切換分支、安裝套件
  | 'running' // AI 執行中
  | 'waiting' // 等你回答（AI 在問問題，或有危險指令等你同意）
  | 'review' // 等你審查：AI 做完了
  | 'blocked' // 卡住了：例如資料夾有未提交的修改
  | 'failed' // 失敗
  | 'stopped' // 你停止了
  | 'removed' // 你從看板移除了（不再顯示）
  | 'committed'; // 你審查後提交了，讓出資料夾

/**
 * 工作項目在哪一區：
 * - waiting：排隊，等輪到跟你對話（照計畫順序）
 * - conversation：對話中，同一時間只有一張；你按「換下一張」才移到開發佇列
 * - development：開發佇列，在背景跑，你自己點進去看
 * - done：已提交或結束
 */
export type WorkLane = 'waiting' | 'conversation' | 'development' | 'done';

/** 審查用：這張單改了哪些檔案 */
export interface ChangedFile {
  path: string;
  /** git 狀態代碼，例如 M、A、D、?? */
  code: string;
  /** 預設要不要勾選提交（environment.ts 預設不勾） */
  suggested: boolean;
}

/** AI 等你處理的事 */
export type PendingRequest =
  | { kind: 'approval'; requestId: number | string; method: string; command: string; reason: string }
  | { kind: 'userInput'; requestId: number | string; questions: { id: string; header: string; question: string; options: string[] }[] }
  /** FlowPilot 自己要你決定的事（例如要不要接著未提交的修改繼續做） */
  | { kind: 'decision'; requestId: string; question: string; options: { id: string; label: string }[] };

/** 一個工作項目：一張單在一個專案（商戶）上的開發，對應一條分支、一個資料夾、一段 Codex 對話 */
export interface WorkItem {
  id: number;
  runId: number;
  ticketKey: string;
  ticketSummary: string;
  mainKey: string;
  mainUrl: string;
  project: string;
  merchant: number | null;
  /** 多商戶時，之後要移植的商戶 */
  targetMerchants: number[];
  branch: string;
  baseBranch: string;
  skill: string;
  prTitle: string;
  /** 分支已存在於某個資料夾時，一定要用那個資料夾 */
  preferredFolder: string | null;
  folder: string | null;
  lane: WorkLane;
  status: WorkStatus;
  /** 目前在做什麼（給人看的一句話） */
  activity: string;
  threadId: string | null;
  lastMessage: string;
  pending: PendingRequest | null;
  updatedAt: string;
}

export interface FolderState {
  name: string;
  path: string;
  project: string;
  /** 目前在這個資料夾的工作項目 */
  itemId: number | null;
}

export interface BoardState {
  folders: FolderState[];
  items: WorkItem[];
  /** 已確認計畫、但還沒開始執行的那次 */
  pendingRun: { id: number; ticketKeys: string[] } | null;
  /** 開發佇列的上限與目前數量 */
  development: { max: number; count: number };
  /** 下一張為什麼還沒開始對話（例如在等資料夾、開發佇列已滿） */
  nextBlockedReason: string | null;
  /** AI 正在寫、還沒寫完的回覆：工作項目編號 → 目前內容 */
  streaming: Record<number, string>;
}

/** 畫面可以呼叫的主程序功能（由 preload 掛在 window.flowpilot） */
export interface FlowPilotApi {
  listTickets(statuses: string[]): Promise<JiraTicket[]>;
  /** 單列表可以選的狀態，以及預設選哪些 */
  statusOptions(): Promise<{ statuses: string[]; defaultStatuses: string[] }>;
  createRun(tickets: JiraTicket[]): Promise<RunSummary>;
  latestRun(): Promise<RunSummary | null>;
  openExternal(url: string): Promise<void>;
  openSettingsFile(): Promise<void>;
  /** 計畫表需要的設定（專案、商戶） */
  planOptions(): Promise<PlanOptions>;
  listSkills(): Promise<SkillInfo[]>;
  judgeTicket(ticket: JiraTicket): Promise<Judgement>;
  /** 算出分支並檢查是否已建立；fetch 為 true 時先抓遠端 */
  checkBranches(plans: TicketPlan[], fetch: boolean): Promise<PlanBranch[]>;
  confirmPlan(runId: number, plans: TicketPlan[], judgements: Record<string, Judgement>): Promise<RunSummary>;
  /** 執行看板 */
  board(): Promise<BoardState>;
  onBoardChanged(listener: (board: BoardState) => void): () => void;
  /** AI 正在寫的回覆即時更新 */
  onStream(listener: (itemId: number, text: string) => void): () => void;
  /** 點系統通知時，跳到那張單 */
  onFocusItem(listener: (itemId: number) => void): () => void;
  startRun(runId: number): Promise<void>;
  /** 回覆 AI（回答問題，或補充指示） */
  reply(itemId: number, text: string): Promise<void>;
  /** 同意或拒絕危險指令 */
  approve(itemId: number, accept: boolean): Promise<void>;
  /** 回答 FlowPilot 要你決定的事 */
  decide(itemId: number, optionId: string): Promise<void>;
  stop(itemId: number): Promise<void>;
  /** 從看板移除（不會動到檔案或分支） */
  remove(itemId: number): Promise<void>;
  /** 對話中的單問完了：移到開發佇列，換下一張 */
  handOff(itemId: number): Promise<void>;
  /** 審查：列出改了哪些檔案 */
  changedFiles(itemId: number): Promise<ChangedFile[]>;
  /** 提交勾選的檔案（訊息用合併請求標題，不推送），讓出資料夾 */
  commit(itemId: number, files: string[]): Promise<{ sha: string; leftover: string[] }>;
  retry(itemId: number): Promise<void>;
  openInVSCode(itemId: number): Promise<void>;
  /** FlowPilot 視窗裡的終端機（接上那張單的 AI 對話） */
  terminal: {
    /** 打開並回傳目前為止的輸出（已經開著就沿用） */
    open(itemId: number, cols: number, rows: number): Promise<string>;
    write(itemId: number, data: string): void;
    resize(itemId: number, cols: number, rows: number): void;
    close(itemId: number): Promise<void>;
    onData(listener: (itemId: number, data: string) => void): () => void;
    onExit(listener: (itemId: number, exitCode: number) => void): () => void;
  };
}

export interface PlanOptions {
  projects: { name: string; merchants: number[] | null }[];
  defaultSkill: string;
}
