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
  /** 合成一個任務的好幾張單（同一條分支、同一段對話、一個 PR）；這張是代表（單號用主單＝單號最小的那張） */
  members?: JiraTicket[];
}

/** 合成一個任務的單，每張的單號、標題、網址 */
export interface TicketRef {
  key: string;
  summary: string;
  url: string;
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
/** 計畫表裡的一張單：加進來就留著，按返回也不會清掉 */
export interface PlanDraft {
  ticket: JiraTicket;
  /** 你改過的計畫；還沒改過是 null（照 AI 審閱的結果） */
  plan: TicketPlan | null;
  /** 你補充的需求來源 */
  extras: SupplementItem[];
}

/** 補充的需求來源：網址（Confluence 會讀內容）、文字、截圖（本機路徑） */
export interface SupplementItem {
  kind: 'url' | 'text' | 'image';
  value: string;
}

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
  /** 你的回答（status 為 answered 時）；討論後 AI 釐清或判斷不是問題時，是它的結論 */
  answer?: string;
  /** 在討論裡由 AI 處理的（釐清了、或判斷不是問題），不是你按的 */
  byDiscussion?: boolean;
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
/** 一項額外檢查：要不要做、為什麼 */
export interface CheckDecision {
  need: boolean;
  reason: string;
}

/**
 * 檢查計畫：審閱時 AI 判斷這張單需要哪些額外檢查（不是每張單都要），你可以在計畫表改。
 * - figma：審閱時對照 Figma 設計稿（只看流程與描述，不管排版細節）
 * - codeReview：開發完 AI 先自我審查程式碼
 * - designCompare：測試時截圖跟設計稿比對
 */
export interface ReviewChecks {
  figma: CheckDecision;
  codeReview: CheckDecision;
  designCompare: CheckDecision;
  /** 開發完要不要跑自動測試（只由你決定，AI 不會改；沒有這個欄位就是要跑） */
  autotest?: CheckDecision;
}

export interface Review extends Judgement {
  ticketKey: string;
  /** 檢查計畫（舊的審閱結果沒有） */
  checks?: ReviewChecks;
  /** 這次審閱有沒有實際對照 Figma 設計稿 */
  figmaChecked?: boolean;
  /** 小單只看單；一般和複雜的單會大略看程式碼 */
  level: '小' | '一般' | '複雜';
  codeChecked: boolean;
  issues: ReviewIssue[];
  discussion: { role: 'you' | 'ai'; text: string; at: string }[];
  reviewedAt: string;
  /** 上次確認過的單內容（子任務、主單） */
  snapshot?: TicketSnapshot[];
  /** 你另外補充的需求來源（Confluence、文字），審閱和開發的 AI 都會看 */
  supplements?: { label: string; text: string }[];
  /** 補充資料裡的截圖（本機路徑），開發的 AI 開工時一起看 */
  supplementImages?: string[];
  /** AI 這次審閱有沒有照要求完成；false 時畫面提醒你重新審閱 */
  complete?: boolean;
  /** 沒完成的原因 */
  problem?: string;
  /** 預期結果逐條（測試時一條一條對照） */
  acceptance?: string[];
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
  | 'parked' // 先交付、待補測：提交推送過了，還有測試沒勾；讓出資料夾，要修時按「繼續修」
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
 * - selfcheck：AI 自我審查程式碼（檢查計畫要做時，開發完接著做）
 * - autotest：AI 用無頭瀏覽器自動測試（開發完自動接著做）
 * - manual：等你手動測試；你在對話裡要求修改，或按「開瀏覽器測給我看」
 * - fix：AI 照你的要求修改中
 * - retest：AI 開瀏覽器重測給你看
 */
export type WorkStage = 'develop' | 'selfcheck' | 'autotest' | 'manual' | 'fix' | 'retest';

export type Env = 'sit' | 'uat';

/**
 * 驗收表：開發的 AI 在測試（或修改）完附的 flowpilot-test 區塊。
 * 以需求為主軸，每一條寫改了什麼、為什麼、改在哪、會影響哪裡、怎麼測，加上測試結果。
 */
export interface TestReport {
  /** 要你注意的地方：AI 自己判斷的、跟 Jira 或設計稿不一致的、需求範圍外也被改到的 */
  attention: string[];
  /** 每一條預期結果 */
  acceptance: AcceptanceItem[];
  /** 跟某一條需求無關、但也改到的東西（例如共用元件、重構） */
  otherChanges: { change: string; why: string; files: string[]; impact: string }[];
  /** 其他要你手動測的項目 */
  manual: { text: string; done: boolean }[];
  /** 「直接完成（不補測）」時還有幾項沒測（有這個欄位就是沒測完就完成的） */
  finishedUntested?: number;
}

export interface AcceptanceItem {
  no: number;
  /** 預期結果的內容 */
  text: string;
  /** AI 的測試結果 */
  result: '通過' | '沒過' | '沒測';
  /** 證據或原因 */
  note: string;
  /** 改了什麼（用畫面上看得到的行為來說） */
  change: string;
  /** 為什麼這樣改、依據哪一段（Jira 預期結果第幾條、API 文件、設計稿） */
  why: string;
  /** 改在哪些檔案 */
  files: string[];
  /** 也會影響到的頁面或功能（沒有就是空字串） */
  impact: string;
  /** 怎麼測：在哪一頁、用哪個商戶、做什麼、應該看到什麼 */
  howToTest: string;
  /** 要測的頁面路徑（例如 /order/list），可以直接在瀏覽器打開 */
  page: string;
  /** AI 認為要你親自測（例如畫面、操作感覺、寫入後的結果）；沒通過的也一律要你看 */
  needYou: boolean;
  /** 你勾了「我測過了」 */
  checked: boolean;
  /** 這次修改或重測後，內容跟上一版不一樣（要重新看） */
  changed: boolean;
}

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
  /** 發出去的 PR（一張單可以發好幾個，例如同一條分支發到 sit、uat、master） */
  prs: PrRecord[];
  /** 從來源商戶移植過來的（多商戶的單）；一般開發是 null */
  portOf: PortSource | null;
  /** 好幾張單合成一個任務時的全部成員（含代表的那張）；一般的單是空的 */
  members: TicketRef[];
  /** 改多語系的進度（沒在改就沒有） */
  i18n?: I18nProgress | null;
  /** 自動測試的結果（AI 回覆最後一行的「測試結果：…」；沒開始成也算沒測成） */
  autotestResult: TestResult | null;
  /** 最近一次瀏覽器測試的報告：預期結果對照、要你手動測的清單（勾選狀態會保留） */
  testReport: TestReport | null;
  updatedAt: string;
}

export interface FolderState {
  name: string;
  path: string;
  project: string;
  /** 目前在這個資料夾的工作項目 */
  itemId: number | null;
}

/** 改多語系的進度：AI 改程式碼 → 停下來（還沒做完）→ FlowPilot 翻譯 → 存到桌面（或失敗） */
export interface I18nProgress {
  phase: 'working' | 'paused' | 'translating' | 'saved' | 'failed';
  /** 開始的時間（毫秒）：對話裡排在這個時間點，像一則訊息，之後的訊息排在它下面 */
  at: number;
  /** 已記下的 key 數 */
  count: number;
  /** 翻譯中：第幾批 / 共幾批 */
  batches?: { done: number; total: number };
  /** 存好的檔名（桌面） */
  file?: string;
  /** 失敗原因、沒翻好的說明 */
  note?: string;
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
  /** 遠端有本機沒有的提交（通常是 rebase 過），推送會用 --force-with-lease 強制推送 */
  needsForce: boolean;
  /** 資料夾目前設定的提交身分（提交時預設用這個） */
  identity: GitIdentity;
  /** 提交時可以選的身分（設定檔的 gitIdentities） */
  identities: GitIdentity[];
}

/** 單列表上的標記 */
export interface TicketMark {
  /** 在工作台上（進行中或已完成），不能再選 */
  active: boolean;
  /** 在工作台上而且已完成 */
  done: boolean;
  /** 在計畫表裡（還沒確認） */
  planning: boolean;
  /** 本機已經有這張單的分支 */
  branch: boolean;
}

/** 移植的來源：來源商戶開發好的分支 */
export interface PortSource {
  merchant: number;
  branch: string;
  baseBranch: string;
}

/** 發過的一個 PR */
export interface PrRecord {
  id: number;
  url: string;
  /** 目標分支（舊資料是空字串） */
  target: string;
  title: string;
  /** 審核人（信箱） */
  reviewers?: string[];
  /** 在 Azure 上的狀態：審核中、已合併、已放棄 */
  status?: 'active' | 'completed' | 'abandoned';
}

/** PR 的審核人（從最近的 PR 抓出來的） */
export interface PrReviewer {
  id: string;
  name: string;
  email: string;
}

/** 發 PR 視窗要的東西 */
export interface PrOptions {
  title: string;
  description: string;
  source: string;
  /** 預設的目標分支（開分支時的基底） */
  target: string;
  branches: string[];
  reviewers: PrReviewer[];
  /** 這條分支在 Azure 上還開著的 PR（同一個目標分支不能再發） */
  existing: PrRecord[];
  /** 遠端沒有這條分支（要先推送） */
  notPushed: boolean;
  /** 同一張單在其他商戶的工作（多商戶的單），可以一起發 PR */
  siblings: { id: number; merchant: number; branch: string; status: WorkStatus; pushed: boolean; prs: PrRecord[] }[];
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
  /** 計畫表裡的單 */
  planDrafts(): Promise<PlanDraft[]>;
  /** 把單加進計畫表（AI 在背景審閱） */
  planAdd(tickets: JiraTicket[]): Promise<PlanDraft[]>;
  /** 好幾張單合成一個任務加進計畫表（同一條分支、同一段對話、一個 PR） */
  planAddGroup(tickets: JiraTicket[]): Promise<PlanDraft[]>;
  /** 存下補充的需求來源（之後重新審閱就會一起看） */
  planSetExtras(ticketKey: string, extras: SupplementItem[]): Promise<PlanDraft[]>;
  /** 存下你在計畫表改過的內容 */
  planSaveDraft(ticketKey: string, plan: TicketPlan): Promise<void>;
  /** 不做了：從計畫表拿掉，審閱紀錄也刪掉 */
  planDiscard(ticketKeys: string[]): Promise<PlanDraft[]>;
  latestRun(): Promise<RunSummary | null>;
  openExternal(url: string): Promise<void>;
  /** 在 Finder 顯示這張單產生的多語系檔 */
  revealI18n(id: number): Promise<void>;
  /** 換一個全新的共用瀏覽器（按「看我的」時用，Chrome 才會再跳出選分頁的頁面） */
  resetSharedBrowser(): Promise<void>;
  /** 介面語言（後端的狀態、錯誤、通知也跟著換） */
  setLang(lang: 'zh' | 'en'): Promise<void>;
  openSettingsFile(): Promise<void>;
  /** 計畫表需要的設定（專案、商戶） */
  planOptions(): Promise<PlanOptions>;
  listSkills(): Promise<SkillInfo[]>;
  /** 審閱一張單（已經審過就直接回傳上次的結果；force 為 true 時重新審閱） */
  reviewTicket(ticket: JiraTicket, force?: boolean): Promise<Review>;
  /** 改檢查計畫（要不要對照 Figma、自我審查、比對設計稿） */
  setReviewChecks(ticketKey: string, checks: ReviewChecks): Promise<Review>;
  /** 處理一個問題：回答、照建議、不是問題、重新打開 */
  updateIssue(ticketKey: string, issueId: string, patch: { status: ReviewIssue['status']; answer?: string }): Promise<Review>;
  /** 跟 AI 討論這張單，AI 會一併更新問題清單 */
  /** 跟 AI 討論這張單；可以附圖 */
  discussReview(ticketKey: string, text: string, images?: string[]): Promise<Review>;
  /** 更新需求：重新讀 Jira 跟上次的內容比對，交給這張單的 AI，在對話裡回答有沒有變更、打算怎麼改 */
  requestRequirementUpdate(itemId: number): Promise<void>;
  /** 算出分支並檢查是否已建立；fetch 為 true 時先抓遠端 */
  checkBranches(plans: TicketPlan[], fetch: boolean): Promise<PlanBranch[]>;
  /** 確認這幾張的計畫，建立分支、交給 AI 開發；其他還在計畫表的不受影響 */
  confirmPlan(plans: TicketPlan[], judgements: Record<string, Judgement>): Promise<RunSummary>;
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
  /** 從工作台移除：刪掉本機分支（遠端不動）、審閱紀錄，回到從沒做過的樣子 */
  remove(itemId: number): Promise<RemoveResult>;
  /** 移除前查分支的狀況：刪掉會失去什麼 */
  branchInfo(itemId: number): Promise<BranchInfo | null>;
  /** 這張單做完了：資料夾要乾淨（environment.ts 可選擇還原），讓出資料夾給下一張 */
  /** skipTests：直接完成（不補測），還沒測的項目記在驗收表上 */
  finish(itemId: number, restoreEnvironment: boolean, skipTests?: boolean): Promise<void>;
  /** 中斷 AI 這一輪（單本身不停止，可以再補充指示） */
  interrupt(itemId: number): Promise<void>;
  /** 送訊息給 AI，可附截圖 */
  send(itemId: number, text: string, images: string[]): Promise<void>;
  /** 存一張貼上的截圖，回傳本機路徑 */
  saveImage(bytes: ArrayBuffer, extension: string): Promise<string>;
  /** 截圖（跟 ⌘⇧4 一樣拖範圍）；取消是 null */
  captureScreen(): Promise<{ path: string; dataUrl: string } | null>;
  /** 完整的對話紀錄 */
  chatHistory(itemId: number): Promise<ChatEntry[]>;
  onChat(listener: (itemId: number, event: ChatEvent) => void): () => void;
  git: {
    state(itemId: number): Promise<GitState>;
    diff(itemId: number, path: string, staged: boolean): Promise<string>;
    stage(itemId: number, paths: string[]): Promise<void>;
    unstage(itemId: number, paths: string[]): Promise<void>;
    discard(itemId: number, paths: string[]): Promise<void>;
    /** 提交全部改動（不用管暫存）：測試用的 environment.ts 不提交，提交前檢查改到的無關檔案自動還原 */
    commitAll(itemId: number, message: string, identity?: string): Promise<CommitResult & { restored: string[] }>;
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
  /** 先交付、待補測：讓出資料夾，欠的測試留著 */
  park(itemId: number): Promise<void>;
  /** 繼續修待補測的單：拿一個空的資料夾、切回分支（資料夾都在用就失敗並說明） */
  resume(itemId: number): Promise<void>;
  /** 多商戶的單：來源商戶完成後，移植到其他商戶（每個商戶一張新的工作），回傳建立的分支 */
  port(itemId: number): Promise<string[]>;
  /** 開瀏覽器測給我看：AI 先列測試計畫給你確認，再開有頭的瀏覽器測 */
  retest(itemId: number): Promise<void>;
  /** 重跑自動測試（無頭）：上次沒測成時用 */
  rerunAutotest(itemId: number): Promise<void>;
  /** 單列表的標記：在工作台上（不能再選）、分支已經存在 */
  ticketMarks(keys: string[]): Promise<Record<string, TicketMark>>;
  /** 這張單現在可以切到哪些 Jira 狀態 */
  ticketTransitions(key: string): Promise<{ id: string; name: string; to: string }[]>;
  /** 切換 Jira 狀態（FlowPilot 對 Jira 唯一的寫入），回傳切換後的狀態 */
  transitionTicket(key: string, transitionId: string): Promise<string>;
  /** 在計畫表返回、沒有確認的單：審閱紀錄不留 */
  pr: {
    /** 發 PR 視窗的預設值、可選的目標分支和審核人 */
    options(itemId: number): Promise<PrOptions>;
    /** 從 Azure 讀回這張單發過的 PR 現在的狀態、目標分支、審核人 */
    refresh(itemId: number): Promise<void>;
    /** 在 Azure 建立 PR，回傳網址 */
    create(itemId: number, input: { title: string; description: string; target: string; reviewerIds: string[]; alsoItemIds?: number[] }): Promise<{ results: { merchant: number | null; target: string; url?: string; error?: string }[] }>;
  };
  test: {
    state(itemId: number): Promise<TestState>;
    /** 切換 SIT／UAT（只切換 environment.ts 裡的註解） */
    setEnvironment(itemId: number, env: Env): Promise<TestState>;
    /** 試登一次：用無頭瀏覽器照帳號檔登入看看（獨立的臨時對話，約一兩分鐘） */
    trialLogin(itemId: number): Promise<{ ok: boolean; reason: string }>;
    /** 勾選或取消手動測試清單的一項 */
    setManualDone(itemId: number, index: number, done: boolean): Promise<void>;
    /** 驗收表的一條勾選「我測過了」 */
    setChecked(itemId: number, no: number, checked: boolean): Promise<void>;
    /** 請 AI 整理驗收表（不重新測試） */
    requestAcceptance(itemId: number): Promise<void>;
    /** 這張單從基底分支到現在改到的檔案（含還沒提交的），用來核對驗收表有沒有漏講 */
    changedFiles(itemId: number): Promise<string[]>;
    /** 驗收表匯出成 CSV，回傳存放位置；取消是 null */
    exportCsv(itemId: number): Promise<string | null>;
    /** 在你的瀏覽器打開本機網站的某一頁（網站沒開會先啟動） */
    openPage(itemId: number, page: string): Promise<void>;
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
