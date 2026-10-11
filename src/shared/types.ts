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
  /** 舊版計畫表選的技能；現在由設定檔決定每個專案用哪個技能 */
  skill?: string;
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

// ---- 審閱：找出單子的問題，跟你一起過 ----

export type IssueType = '邏輯矛盾' | '需求不明確' | '遺漏情境' | '前後端對不上' | '跟設計稿不一致' | '範圍不清' | '跟現有功能衝突';

export interface ReviewIssue {
  id: string;
  type: IssueType;
  /** 重要：做下去可能做錯；一般：可以先照建議做 */
  importance: '重要' | '一般';
  title: string;
  /** 為什麼是問題 */
  detail: string;
  /** 單上的原文出處 */
  quote: string;
  /** 出自哪張單 */
  from: string;
  /** AI 建議的預設做法 */
  suggestion: string;
  /** 還沒處理、你回答了、照 AI 建議、不是問題 */
  status: 'open' | 'answered' | 'assumed' | 'dismissed';
  /** 你的回答（status 為 answered 時） */
  answer?: string;
}

// ---- 需求變更 ----

/** 一張單在某個時間點的內容（用來比對 PM 有沒有改單） */
export interface TicketSnapshot {
  key: string;
  summary: string;
  description: string;
  comments: { id: string; author: string; updated: string; text: string }[];
  attachments: string[];
  takenAt: string;
}

/** 跟上次快照比，單上有哪些內容變了 */
export interface RequirementChange {
  kind: 'summary' | 'description' | 'newComment' | 'editedComment' | 'newAttachment';
  /** 哪張單（主單或子任務） */
  from: string;
  /** 給人看的說明，例如「主單內文被修改」「王小明 新增了一則留言」 */
  title: string;
  /** 內文的逐行差異；留言、標題是整段新內容 */
  lines?: { type: 'add' | 'del'; text: string }[];
  text?: string;
}

/** 審閱結果：判斷（專案、要做什麼、參考資料）＋問題清單＋你們的討論 */
export interface Review extends Judgement {
  ticketKey: string;
  /** 小單只看單；一般和複雜的單會大略看程式碼 */
  level: '小' | '一般' | '複雜';
  codeChecked: boolean;
  issues: ReviewIssue[];
  discussion: { role: 'you' | 'ai'; text: string; at: string }[];
  reviewedAt: string;
  /** 上次確認過的單內容（子任務、主單） */
  snapshot?: TicketSnapshot[];
  /** AI 這次審閱有沒有照要求完成；false 時畫面提醒你重新審閱 */
  complete?: boolean;
  /** 沒完成的原因 */
  problem?: string;
  /** 牽涉頁面（路由、選單、元件） */
  pages?: string[];
  /** 後端 API 規格（單上寫的；沒寫就是空的） */
  apis?: string[];
  /** 預計執行內容（要改哪些地方、怎麼改） */
  steps?: string[];
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
 * - waiting：排隊，等專案有空的資料夾（照計畫順序）
 * - development：進行中（同時進行的數量由資料夾決定）
 * - done：已結束（你按了完成或移除）
 * conversation 是舊版「一次只跟一張單對話」留下的值，現在當成進行中。
 */
export type WorkLane = 'waiting' | 'conversation' | 'development' | 'done';

/**
 * 這張單走到流程的哪一步：
 * - develop：AI 開發中
 * - autotest：AI 用無頭瀏覽器自動測試（開發完自動接著做）
 * - manual：等你手動測試；你在對話裡要求修改，或按「開瀏覽器測給我看」
 * - fix：AI 照你的要求修改中
 * - retest：AI 開瀏覽器重測給你看
 */
export type WorkStage = 'develop' | 'autotest' | 'manual' | 'fix' | 'retest';

export type Env = 'sit' | 'uat';

/** 瀏覽器測試的結果：通過、部分通過、沒測成（主要功能一個都沒測到）、看不出來 */
export interface TestResult {
  kind: 'passed' | 'partial' | 'failed' | 'unknown';
  /** 沒測成或部分通過的原因 */
  reason?: string;
}

/** 工作台右邊「測試」區塊要顯示的狀態 */
export interface TestState {
  /** 資料夾目前連哪個環境；mixed 是兩組都開著或都註解掉，null 是找不到標記 */
  environment: Env | 'mixed' | null;
  /** 這次測試會用的帳號（只有帳號，不含密碼）；帳號檔裡沒有就是 null */
  account: { username: string; hasPassword: boolean } | null;
  /** 帳號檔的位置（沒有帳號時提示你去補） */
  accountFile: string;
}

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
  stage: WorkStage;
  /** 自動測試有沒有真的跑過（沒跑過的顯示「略過」） */
  autotested: boolean;
  /** 自動測試的結果（AI 回覆最後一行的「測試結果：…」；沒開始成也算沒測成） */
  autotestResult: TestResult | null;
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
  /** 資料夾目前設定的提交身分（提交時預設用這個） */
  identity: GitIdentity;
  /** 提交時可以選的身分（設定檔的 gitIdentities） */
  identities: GitIdentity[];
}

export interface CommitResult {
  sha: string;
  /** 提交過程中被專案的提交前檢查改到、跟這次無關的檔案（沒有被提交，留在資料夾裡） */
  hookChanged: string[];
}

/** 提交上寫的名字與信箱（只管提交者，推送登入用的帳號另外存在 Git 的登入資料裡） */
export interface GitIdentity {
  name: string;
  email: string;
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
  /** 審閱一張單（已經審過就直接回傳上次的結果；force 為 true 時重新審閱） */
  reviewTicket(ticket: JiraTicket, force?: boolean): Promise<Review>;
  /** 處理一個問題：回答、照建議、不是問題、重新打開 */
  updateIssue(ticketKey: string, issueId: string, patch: { status: ReviewIssue['status']; answer?: string }): Promise<Review>;
  /** 跟 AI 討論這張單，AI 會一併更新問題清單 */
  discussReview(ticketKey: string, text: string): Promise<Review>;
  /** 更新需求：重新讀 Jira 跟上次的內容比對，交給這張單的 AI，在對話裡回答有沒有變更、打算怎麼改 */
  requestRequirementUpdate(itemId: number): Promise<void>;
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
  /** 從看板移除；deleteBranch 為 true 時順便刪掉本機分支（不動遠端） */
  remove(itemId: number, deleteBranch?: boolean): Promise<RemoveResult>;
  /** 移除前查分支的狀況：刪掉會失去什麼 */
  branchInfo(itemId: number): Promise<BranchInfo | null>;
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
    /** 提交；identity 是這一次要用的身分的信箱，不填就用資料夾設定的 */
    commit(itemId: number, message: string, identity?: string): Promise<CommitResult>;
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
  /** 開瀏覽器測給我看：AI 先列測試計畫給你確認，再開有頭的瀏覽器測 */
  retest(itemId: number): Promise<void>;
  /** 重跑自動測試（無頭）：上次沒測成時用 */
  rerunAutotest(itemId: number): Promise<void>;
  /** 單列表的標記：審閱過了沒、在工作台上、分支已經存在 */
  ticketMarks(keys: string[]): Promise<Record<string, { reviewed: boolean; active: boolean; branch: boolean }>>;
  test: {
    state(itemId: number): Promise<TestState>;
    /** 切換 SIT／UAT（只切換 environment.ts 裡的註解） */
    setEnvironment(itemId: number, env: Env): Promise<TestState>;
    /** 關掉瀏覽器測試開出來的瀏覽器（不會關到你自己的 Chrome），回傳關掉幾個 */
    closeBrowsers(): Promise<number>;
  };
}

/** 移除時要不要刪分支，先讓你看清楚的狀況 */
export interface BranchInfo {
  branch: string;
  folder: string;
  baseBranch: string;
  /** 本機有沒有這條分支 */
  exists: boolean;
  /** 遠端有沒有（有的話刪掉本機的也拿得回來） */
  hasRemote: boolean;
  /** 只在這台電腦上、刪掉就沒了的提交數；null 代表算不出來（例如找不到基底分支） */
  unpushed: number | null;
  /** 沒提交的修改（不含 environment.ts）；有的話不刪分支 */
  dirty: string[];
}

export interface RemoveResult {
  branchDeleted: boolean;
  /** 沒刪分支的原因（有勾刪分支、但沒刪成時） */
  reason?: string;
}

export interface PlanOptions {
  projects: { name: string; merchants: number[] | null; side: string; description: string }[];
}
