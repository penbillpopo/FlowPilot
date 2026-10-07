// 資料庫：~/Library/Application Support/FlowPilot/flowpilot.db（SQLite，用 Node 內建的 node:sqlite）
// 每次狀態改變先寫進來，重新啟動才接得回去。
import { DatabaseSync } from 'node:sqlite';
import type { JiraTicket, Judgement, PendingRequest, RunSummary, TicketPlan, WorkItem, WorkStatus } from '../shared/types';
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
];

/** 還佔著資料夾的狀態 */
export const OCCUPYING: WorkStatus[] = ['preparing', 'running', 'waiting', 'review', 'blocked'];

type NewWorkItem = Omit<WorkItem, 'id' | 'folder' | 'status' | 'activity' | 'threadId' | 'lastMessage' | 'pending' | 'updatedAt'>;

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
  folder: string | null;
  status: WorkStatus;
  activity: string;
  thread_id: string | null;
  last_message: string;
  pending_json: string | null;
  branch_created: number;
  updated_at: string;
}

function toWorkItem(row: WorkItemRow): WorkItem & { branchCreated: boolean } {
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
    folder: row.folder,
    status: row.status,
    activity: row.activity,
    threadId: row.thread_id,
    lastMessage: row.last_message,
    pending: row.pending_json ? (JSON.parse(row.pending_json) as PendingRequest) : null,
    updatedAt: row.updated_at,
    branchCreated: !!row.branch_created,
  };
}

export type StoredWorkItem = ReturnType<typeof toWorkItem>;

const PATCH_COLUMNS = {
  folder: 'folder',
  status: 'status',
  activity: 'activity',
  threadId: 'thread_id',
  lastMessage: 'last_message',
  branchCreated: 'branch_created',
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
         branch, base_branch, skill, pr_title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    const ids: number[] = [];
    this.db.exec('BEGIN');
    try {
      for (const i of items) {
        const t = now.toISOString();
        const r = insert.run(i.runId, i.ticketKey, i.ticketSummary, i.mainKey, i.mainUrl, i.project, i.merchant, JSON.stringify(i.targetMerchants),
          i.branch, i.baseBranch, i.skill, i.prTitle, t, t);
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
        `SELECT * FROM work_items WHERE status NOT IN ('failed', 'stopped')
         UNION SELECT * FROM (SELECT * FROM work_items WHERE status IN ('failed', 'stopped') ORDER BY id DESC LIMIT 30)
         ORDER BY id`,
      )
      .all() as unknown as WorkItemRow[];
    return rows.map(toWorkItem);
  }

  updateWorkItem(
    id: number,
    patch: Partial<Pick<StoredWorkItem, keyof typeof PATCH_COLUMNS>> & { pending?: PendingRequest | null },
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
    if ('pending' in patch) {
      sets.push('pending_json = ?');
      values.push(patch.pending ? JSON.stringify(patch.pending) : null);
    }
    this.db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getWorkItem(id)!;
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
