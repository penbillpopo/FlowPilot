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
  /** 這張單要做什麼（重點條列） */
  summary?: string[];
  /** 單上附的參考資料 */
  resources?: Resource[];
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

/** 單上附的參考資料（從 Jira 內文、留言、附件直接擷取，不經過 AI） */
export interface Resource {
  kind: 'figma' | 'document' | 'jira' | 'attachment' | 'link';
  title: string;
  url: string;
  /** 出現在哪張單（主單或子任務的單號） */
  from: string;
}

/** AI 判斷的結果（還沒經過你修改） */
export interface Judgement {
  entries: PlanEntry[];
  prTitle: string;
  reason: string;
  /** 這張單要做什麼（重點條列） */
  summary: string[];
  /** 單上附的參考資料 */
  resources: Resource[];
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

// ---- 工作台：聊天、Git、本機網站 ----

/** 對話裡的一則紀錄（你的訊息、AI 回覆、思考、指令、改動、工具…） */
export interface ChatEntry {
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'command' | 'fileChange' | 'tool' | 'plan' | 'search' | 'notice';
  /** 主要文字：訊息內容、思考摘要、計畫、工具名稱… */
  text: string;
  /** 指令 */
  command?: string;
  /** 指令輸出 */
  output?: string;
  exitCode?: number | null;
  /** 進行中、完成、失敗… */
  status?: string;
  /** 改了哪些檔案（含差異） */
  files?: { path: string; kind: string; diff: string }[];
  /** 你附上的圖片（本機路徑） */
  images?: string[];
  at?: number | null;
}

/** 聊天的即時更新 */
export type ChatEvent =
  | { type: 'upsert'; entry: ChatEntry }
  | { type: 'delta'; id: string; field: 'text' | 'output'; delta: string };

export interface GitFile {
  path: string;
  /** 狀態代碼：M 修改、A 新增、D 刪除、R 改名、U 新檔案（未追蹤） */
  code: string;
}

export interface GitState {
  branch: string;
  /** 準備提交（已暫存） */
  staged: GitFile[];
  /** 變更（未暫存，含新檔案） */
  unstaged: GitFile[];
  /** 本機有幾個提交還沒推送；null 代表遠端還沒有這條分支 */
  unpushed: number | null;
  /** 遠端有沒有這條分支 */
  hasRemote: boolean;
  /** 比基底分支多幾個提交 */
  ahead: number;
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
  /** 這張單做完了：資料夾要乾淨（environment.ts 可選擇還原），讓出資料夾給下一張 */
  finish(itemId: number, restoreEnvironment: boolean): Promise<void>;
  /** 中斷 AI 這一輪（單本身不停止，可以再補充指示） */
  interrupt(itemId: number): Promise<void>;
  /** 送訊息給 AI，可附截圖 */
  send(itemId: number, text: string, images: string[]): Promise<void>;
  /** 存一張貼上的截圖，回傳本機路徑 */
  saveImage(bytes: ArrayBuffer, extension: string): Promise<string>;
  /** 完整的對話紀錄 */
  chatHistory(itemId: number): Promise<ChatEntry[]>;
  onChat(listener: (itemId: number, event: ChatEvent) => void): () => void;
  git: {
    state(itemId: number): Promise<GitState>;
    diff(itemId: number, path: string, staged: boolean): Promise<string>;
    stage(itemId: number, paths: string[]): Promise<void>;
    unstage(itemId: number, paths: string[]): Promise<void>;
    discard(itemId: number, paths: string[]): Promise<void>;
    commit(itemId: number, message: string): Promise<string>;
    push(itemId: number): Promise<string>;
  };
  /** 資料夾終端機：每個資料夾一個互動式 shell */
  folderTerminal: {
    /** 打開（已經開著就沿用），回傳目前為止的輸出與抓到的本機網址 */
    open(itemId: number, cols: number, rows: number): Promise<{ folder: string; buffer: string; url: string | null }>;
    write(folder: string, data: string): void;
    resize(folder: string, cols: number, rows: number): void;
    /** 在終端機裡執行啟動本機網站的指令 */
    startSite(itemId: number): Promise<void>;
    /** 等於按 Ctrl+C */
    interrupt(folder: string): void;
    onData(listener: (folder: string, data: string) => void): () => void;
    onUrl(listener: (folder: string, url: string | null) => void): () => void;
    onExit(listener: (folder: string) => void): () => void;
  };
  openUrl(url: string): Promise<void>;
  retry(itemId: number): Promise<void>;
  openInVSCode(itemId: number): Promise<void>;
}

export interface PlanOptions {
  projects: { name: string; merchants: number[] | null; side: string; description: string }[];
  defaultSkill: string;
}
