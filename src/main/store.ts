// 資料庫：~/Library/Application Support/FlowPilot/flowpilot.db（SQLite，用 Node 內建的 node:sqlite）
// 每次狀態改變先寫進來，重新啟動才接得回去。
import { DatabaseSync } from 'node:sqlite';
import type { AcceptanceItem, JiraTicket, PlanDraft, PrRecord, Judgement, PendingRequest, Review, RunSummary, TestReport, TestResult, TicketPlan, WorkItem, WorkLane, WorkStage, WorkStatus } from '../shared/types';
import type { PastDecision } from './planner/judge';

// 依序執行的資料庫結構變更；只能往後加，不能改前面的
const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     status TEXT NOT NULL
   );
   CREATE TABLE run_tickets (
     run_id INTEGER NOT NULL REFERENCES runs(id),
     ticket_key TEXT NOT NULL,
     ticket_json TEXT NOT NULL,
     PRIMARY KEY (run_id, ticket_key)
   );`,
  // 第 2 階段：確認好的計畫、你確認過的判斷（下次給 AI 參考）
  `ALTER TABLE runs ADD COLUMN plan_json TEXT;
   CREATE TABLE decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     ticket_key TEXT NOT NULL,
     summary TEXT NOT NULL,
     main_summary TEXT NOT NULL,
     ai_json TEXT,
     final_json TEXT NOT NULL,
     changed INTEGER NOT NULL
   );`,
  // 第 3、4 階段：工作項目（一條分支、一個資料夾、一段 Codex 對話）
  `CREATE TABLE work_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES runs(id),
     ticket_key TEXT NOT NULL,
     ticket_summary TEXT NOT NULL,
     main_key TEXT NOT NULL,
     main_url TEXT NOT NULL,
     project TEXT NOT NULL,
     merchant INTEGER,
     target_merchants TEXT NOT NULL,
     branch TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     skill TEXT NOT NULL,
     pr_title TEXT NOT NULL,
     folder TEXT,
     status TEXT NOT NULL,
     activity TEXT NOT NULL DEFAULT '',
     thread_id TEXT,
     last_message TEXT NOT NULL DEFAULT '',
     pending_json TEXT,
     branch_created INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 已存在的分支繼續開發：分支在哪個資料夾，就要用哪個資料夾
  `ALTER TABLE work_items ADD COLUMN preferred_folder TEXT;`,
  // 一次只跟一張單對話：工作項目分成排隊、對話中、開發佇列、已完成
  `ALTER TABLE work_items ADD COLUMN lane TEXT NOT NULL DEFAULT 'waiting';
   ALTER TABLE work_items ADD COLUMN commit_sha TEXT;
   UPDATE work_items SET lane = 'done' WHERE status IN ('removed', 'stopped', 'failed');
   UPDATE work_items SET lane = 'development' WHERE lane = 'waiting' AND status != 'queued';`,
  // 審閱結果：每張單一份（PM 隔天才回也還在；同一張單下次再選不用重新審閱）
  `CREATE TABLE reviews (
     ticket_key TEXT PRIMARY KEY,
     review_json TEXT NOT NULL,
     thread_id TEXT,
     updated_at TEXT NOT NULL
   );`,
  // 雜項設定值（目前沒有使用）
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 流程階段（開發 → 自動測試 → 等你測試 → 修改／重測）；已經開始的舊單直接當成等你測試，不會突然自己跑測試
  // 這張單指定的測試帳號（這個功能後來拿掉了，欄位留著不用）
  `ALTER TABLE work_items ADD COLUMN stage TEXT NOT NULL DEFAULT 'develop';
   UPDATE work_items SET stage = 'manual' WHERE thread_id IS NOT NULL;
   ALTER TABLE work_items ADD COLUMN test_username TEXT;
   ALTER TABLE work_items ADD COLUMN test_password TEXT;`,
  // 自動測試有沒有真的跑過（舊單沒跑過，畫面顯示「略過」）
  `ALTER TABLE work_items ADD COLUMN autotested INTEGER NOT NULL DEFAULT 0;`,
  // 自動測試的結果（通過、部分通過、沒測成）：沒測成不再打勾
  `ALTER TABLE work_items ADD COLUMN autotest_result TEXT;`,
  // 最近一次瀏覽器測試的報告：預期結果對照、手動測試清單
  `ALTER TABLE work_items ADD COLUMN test_report TEXT;`,
  // 計畫表的草稿：加進計畫表、還沒確認的單（按返回也留著，連同你改過的專案、標題）
  `CREATE TABLE plan_drafts (
     ticket_key TEXT PRIMARY KEY,
     ticket_json TEXT NOT NULL,
     plan_json TEXT,
     added_at TEXT NOT NULL
   );`,
  // 發出去的 PR 網址（同一張單不重複發）
  `ALTER TABLE work_items ADD COLUMN pr_url TEXT;`,
  // 一張單可以發好幾個 PR（例如同一條分支發到 sit、uat、master），改成存清單；舊的單一網址搬進去
  `ALTER TABLE work_items ADD COLUMN prs TEXT;
   UPDATE work_items SET prs = json_array(json_object('id', 0, 'url', pr_url, 'target', '', 'title', '')) WHERE pr_url IS NOT NULL;`,
];

/** 還佔著資料夾的狀態 */
export const OCCUPYING: WorkStatus[] = ['preparing', 'running', 'waiting', 'review', 'blocked'];

/** 已經結束的狀態 */
export const FINISHED: WorkStatus[] = ['failed', 'stopped', 'removed', 'committed'];

type NewWorkItem = Omit<WorkItem, 'id' | 'folder' | 'lane' | 'status' | 'activity' | 'threadId' | 'lastMessage' | 'pending' | 'stage' | 'autotested' | 'autotestResult' | 'testReport' | 'updatedAt' | 'prs'>;

interface WorkItemRow {
  id: number;
  run_id: number;
  ticket_key: string;
  ticket_summary: string;
  main_key: string;
  main_url: string;
  project: string;
  merchant: number | null;
  target_merchants: string;
  branch: string;
  base_branch: string;
  skill: string;
  pr_title: string;
  preferred_folder: string | null;
  folder: string | null;
  lane: WorkLane;
  status: WorkStatus;
  activity: string;
  thread_id: string | null;
  last_message: string;
  pending_json: string | null;
  branch_created: number;
  commit_sha: string | null;
  pr_url: string | null;
  prs: string | null;
  stage: WorkStage;
  autotested: number;
  autotest_result: string | null;
  test_report: string | null;
  test_username: string | null;
  test_password: string | null;
  updated_at: string;
}

function toWorkItem(row: WorkItemRow): WorkItem & { branchCreated: boolean; commitSha: string | null } {
  return {
    id: row.id,
    runId: row.run_id,
    ticketKey: row.ticket_key,
    ticketSummary: row.ticket_summary,
    mainKey: row.main_key,
    mainUrl: row.main_url,
    project: row.project,
    merchant: row.merchant,
    targetMerchants: JSON.parse(row.target_merchants),
    branch: row.branch,
    baseBranch: row.base_branch,
    skill: row.skill,
    prTitle: row.pr_title,
    preferredFolder: row.preferred_folder,
    folder: row.folder,
    lane: row.lane,
    status: row.status,
    activity: row.activity,
    threadId: row.thread_id,
    lastMessage: row.last_message,
    pending: row.pending_json ? (JSON.parse(row.pending_json) as PendingRequest) : null,
    stage: row.stage,
    autotested: !!row.autotested,
    autotestResult: row.autotest_result ? (JSON.parse(row.autotest_result) as TestResult) : null,
    testReport: row.test_report ? normalizeReport(JSON.parse(row.test_report)) : null,
    updatedAt: row.updated_at,
    branchCreated: !!row.branch_created,
    commitSha: row.commit_sha,
    prs: row.prs ? (JSON.parse(row.prs) as PrRecord[]) : [],
  };
}

export type StoredWorkItem = ReturnType<typeof toWorkItem>;

const PATCH_COLUMNS = {
  folder: 'folder',
  lane: 'lane',
  commitSha: 'commit_sha',
  preferredFolder: 'preferred_folder',
  status: 'status',
  activity: 'activity',
  threadId: 'thread_id',
  lastMessage: 'last_message',
  branchCreated: 'branch_created',
  stage: 'stage',
  autotested: 'autotested',
} as const;

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /** 你勾選完的單，存成一次新的執行 */
  createRun(tickets: JiraTicket[], now = new Date()): RunSummary {
    if (tickets.length === 0) throw new Error('沒有勾選任何單');
    this.db.exec('BEGIN');
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO runs (created_at, status) VALUES (?, ?)')
        .run(now.toISOString(), 'selected');
      const insert = this.db.prepare('INSERT INTO run_tickets (run_id, ticket_key, ticket_json) VALUES (?, ?, ?)');
      for (const ticket of tickets) insert.run(lastInsertRowid, ticket.key, JSON.stringify(ticket));
      this.db.exec('COMMIT');
      return this.getRun(Number(lastInsertRowid))!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 確認計畫：存下計畫，並記錄每張單的最終判斷（跟 AI 不同的標記為修改過） */
  confirmPlan(runId: number, plans: TicketPlan[], judgements: Record<string, Judgement>, now = new Date()): RunSummary {
    if (!this.getRun(runId)) throw new Error(`找不到第 ${runId} 次執行`);
    const brief = (entries: { project: string; merchants: number[] }[]) =>
      entries.map((e) => ({ project: e.project, merchants: [...e.merchants].sort((a, b) => a - b) }));
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE runs SET status = ?, plan_json = ? WHERE id = ?').run('planned', JSON.stringify(plans), runId);
      const insert = this.db.prepare(
        'INSERT INTO decisions (created_at, ticket_key, summary, main_summary, ai_json, final_json, changed) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const plan of plans) {
        const ai = judgements[plan.ticket.key];
        const final = JSON.stringify(brief(plan.entries));
        const aiJson = ai ? JSON.stringify(brief(ai.entries)) : null;
        insert.run(now.toISOString(), plan.ticket.key, plan.ticket.summary, plan.ticket.parent?.summary ?? '', aiJson, final, aiJson === final ? 0 : 1);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRun(runId)!;
  }

  /** 最近確認過的判斷（同一張單只取最新一次），越新越前面 */
  recentDecisions(limit = 30): PastDecision[] {
    const rows = this.db
      .prepare(
        `SELECT ticket_key, summary, main_summary, final_json FROM decisions
         WHERE id IN (SELECT MAX(id) FROM decisions GROUP BY ticket_key)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as { ticket_key: string; summary: string; main_summary: string; final_json: string }[];
    return rows.map((r) => ({ ticketKey: r.ticket_key, summary: r.summary, mainSummary: r.main_summary, final: JSON.parse(r.final_json) }));
  }

  getPlan(runId: number): TicketPlan[] | null {
    const row = this.db.prepare('SELECT plan_json FROM runs WHERE id = ?').get(runId) as { plan_json: string | null } | undefined;
    return row?.plan_json ? JSON.parse(row.plan_json) : null;
  }

  // ---- 工作項目 ----

  createWorkItems(items: NewWorkItem[], now = new Date()): StoredWorkItem[] {
    const insert = this.db.prepare(
      `INSERT INTO work_items (run_id, ticket_key, ticket_summary, main_key, main_url, project, merchant, target_merchants,
         branch, base_branch, skill, pr_title, preferred_folder, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    const ids: number[] = [];
    this.db.exec('BEGIN');
    try {
      for (const i of items) {
        const t = now.toISOString();
        const r = insert.run(i.runId, i.ticketKey, i.ticketSummary, i.mainKey, i.mainUrl, i.project, i.merchant, JSON.stringify(i.targetMerchants),
          i.branch, i.baseBranch, i.skill, i.prTitle, i.preferredFolder, t, t);
        ids.push(Number(r.lastInsertRowid));
      }
      if (items.length) this.db.prepare("UPDATE runs SET status = 'started' WHERE id = ?").run(items[0].runId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return ids.map((id) => this.getWorkItem(id)!);
  }

  markRunStarted(runId: number) {
    this.db.prepare("UPDATE runs SET status = 'started' WHERE id = ?").run(runId);
  }

  getWorkItem(id: number): StoredWorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  findWorkItemByThread(threadId: string): StoredWorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(threadId) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  /** 看板要顯示的工作項目：還沒結束的，加上最近 30 個已結束的 */
  listWorkItems(): StoredWorkItem[] {
    const rows = this.db
      .prepare(
        // 工作台上的單：還沒被移除的都算（已完成的也留著，等你移除）
        "SELECT * FROM work_items WHERE status != 'removed' ORDER BY id",
      )
      .all() as unknown as WorkItemRow[];
    return rows.map(toWorkItem);
  }

  updateWorkItem(
    id: number,
    patch: Partial<Pick<StoredWorkItem, keyof typeof PATCH_COLUMNS>> & { pending?: PendingRequest | null; autotestResult?: TestResult | null; testReport?: TestReport | null; prs?: PrRecord[] },
    now = new Date(),
  ): StoredWorkItem {
    const sets: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now.toISOString()];
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        const v = (patch as Record<string, unknown>)[key];
        values.push(typeof v === 'boolean' ? Number(v) : (v as string | number | null));
      }
    }
    if ('prs' in patch) {
      sets.push('prs = ?');
      values.push(patch.prs?.length ? JSON.stringify(patch.prs) : null);
    }
    if ('testReport' in patch) {
      sets.push('test_report = ?');
      values.push(patch.testReport ? JSON.stringify(patch.testReport) : null);
    }
    if ('autotestResult' in patch) {
      sets.push('autotest_result = ?');
      values.push(patch.autotestResult ? JSON.stringify(patch.autotestResult) : null);
    }
    if ('pending' in patch) {
      sets.push('pending_json = ?');
      values.push(patch.pending ? JSON.stringify(patch.pending) : null);
    }
    this.db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getWorkItem(id)!;
  }

  /** 這張單（單號）在不在工作台上：還沒被移除的都算，包括已完成的（多專案的單可能有好幾列） */
  hasActiveTicket(ticketKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM work_items WHERE ticket_key = ? AND status != 'removed' LIMIT 1").get(ticketKey);
  }

  /** 這張單在工作台上的狀態：每一列都已完成才算「已完成」，其他（含失敗、停止、排隊）都算「進行中」；不在工作台上回 null */
  ticketWorkState(ticketKey: string): 'active' | 'done' | null {
    const rows = this.db.prepare("SELECT status FROM work_items WHERE ticket_key = ? AND status != 'removed'").all(ticketKey) as { status: string }[];
    if (!rows.length) return null;
    return rows.every((r) => r.status === 'committed') ? 'done' : 'active';
  }

  // ---- 計畫表的草稿 ----

  /** 加進計畫表（已經在的不重複加，保留原本的內容） */
  addDrafts(tickets: JiraTicket[], now = new Date()) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO plan_drafts (ticket_key, ticket_json, added_at) VALUES (?, ?, ?)');
    for (const ticket of tickets) insert.run(ticket.key, JSON.stringify(ticket), now.toISOString());
  }

  /** 計畫表裡的單（先加的在前）；plan 是你改過的計畫，還沒改過是 null */
  listDrafts(): PlanDraft[] {
    const rows = this.db.prepare('SELECT * FROM plan_drafts ORDER BY added_at, ticket_key').all() as { ticket_json: string; plan_json: string | null }[];
    return rows.map((r) => ({ ticket: JSON.parse(r.ticket_json), plan: r.plan_json ? JSON.parse(r.plan_json) : null }));
  }

  saveDraftPlan(ticketKey: string, plan: TicketPlan) {
    this.db.prepare('UPDATE plan_drafts SET plan_json = ? WHERE ticket_key = ?').run(JSON.stringify(plan), ticketKey);
  }

  removeDrafts(ticketKeys: string[]) {
    const del = this.db.prepare('DELETE FROM plan_drafts WHERE ticket_key = ?');
    for (const key of ticketKeys) del.run(key);
  }

  isDraft(ticketKey: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM plan_drafts WHERE ticket_key = ?').get(ticketKey);
  }

  /** 同一個專案、同一條分支還沒結束的工作項目（避免重複建立） */
  activeWorkItem(project: string, branch: string): StoredWorkItem | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE project = ? AND branch = ? AND status NOT IN ('failed', 'stopped', 'removed', 'committed') ORDER BY id DESC LIMIT 1")
      .get(project, branch) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  // ---- 審閱 ----

  getReview(ticketKey: string): { review: Review; threadId: string | null } | null {
    const row = this.db.prepare('SELECT review_json, thread_id FROM reviews WHERE ticket_key = ?').get(ticketKey) as
      | { review_json: string; thread_id: string | null }
      | undefined;
    return row ? { review: JSON.parse(row.review_json), threadId: row.thread_id } : null;
  }

  /** 刪掉一張單的審閱紀錄（單離開工作台、或在計畫表返回沒確認時） */
  deleteReview(ticketKey: string) {
    this.db.prepare('DELETE FROM reviews WHERE ticket_key = ?').run(ticketKey);
  }

  /** 審閱紀錄跟著計畫表和工作台走：都不在的單，審閱紀錄全部清掉；回傳清掉幾筆 */
  purgeOrphanReviews(): number {
    const result = this.db
      .prepare("DELETE FROM reviews WHERE ticket_key NOT IN (SELECT ticket_key FROM work_items WHERE status != 'removed') AND ticket_key NOT IN (SELECT ticket_key FROM plan_drafts)")
      .run();
    return Number(result.changes);
  }

  saveReview(review: Review, threadId: string | null, now = new Date()) {
    this.db
      .prepare(
        `INSERT INTO reviews (ticket_key, review_json, thread_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ticket_key) DO UPDATE SET review_json = excluded.review_json, thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
      )
      .run(review.ticketKey, JSON.stringify(review), threadId, now.toISOString());
  }

  /** 已確認計畫、但還沒開始執行的最近一次 */
  pendingPlannedRun(): { id: number; ticketKeys: string[] } | null {
    const row = this.db.prepare("SELECT id FROM runs WHERE status = 'planned' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (!row) return null;
    return { id: row.id, ticketKeys: (this.getPlan(row.id) ?? []).map((p) => p.ticket.key) };
  }

  getRun(id: number): RunSummary | null {
    const run = this.db.prepare('SELECT id, created_at, status FROM runs WHERE id = ?').get(id) as
      | { id: number; created_at: string; status: string }
      | undefined;
    if (!run) return null;
    const keys = this.db.prepare('SELECT ticket_key FROM run_tickets WHERE run_id = ? ORDER BY ticket_key').all(id) as { ticket_key: string }[];
    return { id: run.id, createdAt: run.created_at, status: run.status, ticketKeys: keys.map((k) => k.ticket_key) };
  }

  latestRun(): RunSummary | null {
    const row = this.db.prepare('SELECT id FROM runs ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    return row ? this.getRun(row.id) : null;
  }

  close() {
    this.db.close();
  }
}

/** 舊版的測試報告沒有驗收表的欄位，補上預設值 */
function normalizeReport(data: Partial<TestReport>): TestReport {
  return {
    attention: data.attention ?? [],
    otherChanges: data.otherChanges ?? [],
    manual: data.manual ?? [],
    acceptance: (data.acceptance ?? []).map((a: Partial<AcceptanceItem>) => ({
      ...{ change: '', why: '', files: [], impact: '', howToTest: '', page: '', needYou: false, checked: false, changed: false },
      ...a,
    }) as AcceptanceItem),
  };
}
