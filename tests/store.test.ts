import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/main/store';
import { groupTicket } from '../src/shared/group';
import type { JiraTicket } from '../src/shared/types';

function ticket(key: string): JiraTicket {
  return { key, summary: key, status: '進行中', issueType: '子任務', updated: '', url: '', parent: null };
}

describe('資料庫', () => {
  it('記錄勾選的單，重新開啟後還在', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flowpilot-')), 'flowpilot.db');
    const store = new Store(file);
    const run = store.createRun([ticket('ALL-2'), ticket('ALL-1')], new Date('2026-10-07T01:00:00Z'));
    expect(run).toEqual({ id: 1, createdAt: '2026-10-07T01:00:00.000Z', status: 'selected', ticketKeys: ['ALL-1', 'ALL-2'] });
    store.close();

    const reopened = new Store(file);
    expect(reopened.latestRun()).toEqual(run);
    reopened.close();
  });

  it('沒有勾選時不建立', () => {
    const store = new Store(':memory:');
    expect(() => store.createRun([])).toThrow('沒有勾選');
    expect(store.latestRun()).toBeNull();
  });
});

describe('計畫與修正紀錄', () => {
  it('確認計畫後存下計畫，並記錄跟 AI 不同的判斷', () => {
    const store = new Store(':memory:');
    const a = { ...ticket('ALL-1'), summary: '單一' };
    const b = { ...ticket('ALL-2'), summary: '單二' };
    const run = store.createRun([a, b]);
    const entry = (merchants: number[]) => ({ project: 'PlatformWeb', merchants, sourceMerchant: merchants[0] ?? null, reason: '' });
    const plans = [
      { ticket: a, entries: [entry([8])], skill: 'frontend-workflow', prTitle: 'feat(ALL-1) a', reason: '' },
      { ticket: b, entries: [entry([2, 1])], skill: 'frontend-workflow', prTitle: 'feat(ALL-2) b', reason: '' },
    ];
    const judgements = {
      'ALL-1': { entries: [entry([8])], prTitle: '', reason: '', summary: [], resources: [] },
      'ALL-2': { entries: [entry([5])], prTitle: '', reason: '', summary: [], resources: [] },
    };
    expect(store.confirmPlan(run.id, plans, judgements).status).toBe('planned');
    expect(store.getPlan(run.id)).toEqual(plans);
    expect(store.recentDecisions()).toEqual([
      { ticketKey: 'ALL-2', summary: '單二', mainSummary: '', final: [{ project: 'PlatformWeb', merchants: [1, 2] }] },
      { ticketKey: 'ALL-1', summary: '單一', mainSummary: '', final: [{ project: 'PlatformWeb', merchants: [8] }] },
    ]);
  });

  it('舊版資料庫可以直接升級', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flowpilot-')), 'flowpilot.db');
    new Store(file).close();
    const store = new Store(file);
    expect(store.recentDecisions()).toEqual([]);
    store.close();
  });
});

describe('工作項目', () => {
  it('同一條分支還沒結束時找得到；移除後不再顯示、也不算進行中', () => {
    const store = new Store(':memory:');
    const run = store.createRun([ticket('ALL-1')]);
    const [item] = store.createWorkItems([{
      runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformWeb', merchant: 1,
      targetMerchants: [], branch: 'ban/m1/ALL-1', baseBranch: 'master-1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
    }]);
    expect(store.activeWorkItem('PlatformWeb', 'ban/m1/ALL-1')?.id).toBe(item.id);
    expect(store.activeWorkItem('PlatformAdmin', 'ban/m1/ALL-1')).toBeNull();
    store.updateWorkItem(item.id, { status: 'removed' });
    expect(store.activeWorkItem('PlatformWeb', 'ban/m1/ALL-1')).toBeNull();
    expect(store.listWorkItems()).toEqual([]);
  });
});

describe('計畫表的草稿', () => {
  it('加進去就留著；改過的計畫存起來；重複加不會蓋掉；審閱紀錄跟著草稿留下', () => {
    const store = new Store(':memory:');
    store.addDrafts([ticket('ALL-1'), ticket('ALL-2')]);
    const plan = { ticket: ticket('ALL-1'), entries: [{ project: 'PlatformAdmin', merchants: [], sourceMerchant: null, reason: '' }], prTitle: 'feat(ALL-1) x', reason: '' };
    store.saveDraftPlan('ALL-1', plan);
    store.addDrafts([ticket('ALL-1')]); // 再加一次：保留原本改過的
    expect(store.listDrafts().map((d) => [d.ticket.key, d.plan?.prTitle ?? null])).toEqual([['ALL-1', 'feat(ALL-1) x'], ['ALL-2', null]]);
    expect(store.isDraft('ALL-2')).toBe(true);

    const review = (key: string) => ({ ticketKey: key, entries: [], prTitle: '', reason: '', summary: [], resources: [], level: '小' as const, codeChecked: false, issues: [], discussion: [], reviewedAt: '' });
    store.saveReview(review('ALL-1'), 't1');
    store.saveReview(review('ALL-9'), 't9');
    expect(store.purgeOrphanReviews()).toBe(1); // 只清掉不在計畫表也不在工作台的
    expect(store.getReview('ALL-1')).not.toBeNull();

    store.removeDrafts(['ALL-1']);
    expect(store.listDrafts().map((d) => d.ticket.key)).toEqual(['ALL-2']);
    expect(store.isDraft('ALL-1')).toBe(false);
  });
});

describe('發過的 PR', () => {
  it('一張單可以記好幾個 PR；沒發過是空的', () => {
    const store = new Store(':memory:');
    const run = store.createRun([ticket('ALL-1')]);
    const [item] = store.createWorkItems([{
      runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformWeb', merchant: 1,
      targetMerchants: [], branch: 'ban/m1/ALL-1', baseBranch: 'master-1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
    }]);
    expect(store.getWorkItem(item.id)!.prs).toEqual([]);
    const sit = { id: 1, url: 'https://x/pullrequest/1', target: 'sit-1', title: 'feat(ALL-1) x' };
    const uat = { id: 2, url: 'https://x/pullrequest/2', target: 'uat-1', title: 'feat(ALL-1) x' };
    store.updateWorkItem(item.id, { prs: [sit] });
    store.updateWorkItem(item.id, { prs: [sit, uat] });
    expect(store.getWorkItem(item.id)!.prs.map((p) => p.target)).toEqual(['sit-1', 'uat-1']);
  });

  it('舊版存的單一 PR 網址搬進清單', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fp-pr-')), 'db.sqlite');
    const old = new Store(file);
    const run = old.createRun([ticket('ALL-2')]);
    const [item] = old.createWorkItems([{
      runId: run.id, ticketKey: 'ALL-2', ticketSummary: '', mainKey: 'ALL-2', mainUrl: '', project: 'PlatformWeb', merchant: 1,
      targetMerchants: [], branch: 'ban/m1/ALL-2', baseBranch: 'master-1', skill: 'x', prTitle: 'feat(ALL-2) x', preferredFolder: null,
    }]);
    // 模擬舊版：只有 pr_url，還沒有 prs
    const db = (old as unknown as { db: { exec(sql: string): void; prepare(sql: string): { get(): unknown } } }).db;
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    // 退回到加 prs 欄位之前（之後的升級也一起退掉）
    db.exec(`UPDATE work_items SET pr_url = 'https://x/pullrequest/9', prs = NULL; PRAGMA user_version = ${version - 5}; ALTER TABLE work_items DROP COLUMN old_threads; ALTER TABLE plan_drafts DROP COLUMN extras_json; ALTER TABLE work_items DROP COLUMN members; ALTER TABLE work_items DROP COLUMN port_of; ALTER TABLE work_items DROP COLUMN prs;`);
    old.close();
    const store = new Store(file);
    expect(store.getWorkItem(item.id)!.prs).toEqual([{ id: 0, url: 'https://x/pullrequest/9', target: '', title: '' }]);
    store.close();
  });
});

describe('合成一個任務', () => {
  it('成員單也算在工作台、計畫表裡（單列表會鎖住）', () => {
    const store = new Store(':memory:');
    const group = groupTicket([ticket('ALL-14800'), ticket('ALL-14798'), ticket('ALL-14799')]);
    store.addDrafts([group]);
    expect(store.isDraft('ALL-14799')).toBe(true);
    expect(store.isDraft('ALL-1')).toBe(false);
    store.removeDrafts([group.key]);
    const run = store.createRun([group]);
    const [item] = store.createWorkItems([{
      runId: run.id, ticketKey: group.key, ticketSummary: group.summary, mainKey: group.key, mainUrl: '', project: 'PlatformWeb', merchant: 10,
      targetMerchants: [], branch: 'ban/m10/ALL-14798', baseBranch: 'master-10', skill: 'x', prTitle: 'feat(ALL-14798, ALL-14799, ALL-14800) x', preferredFolder: null,
      members: group.members!.map((m) => ({ key: m.key, summary: m.summary, url: m.url })),
    }]);
    expect(store.getWorkItem(item.id)!.members.map((m) => m.key)).toEqual(['ALL-14798', 'ALL-14799', 'ALL-14800']);
    expect(store.ticketWorkState('ALL-14800')).toBe('active');
    expect(store.hasActiveTicket('ALL-14799')).toBe(true);
    store.updateWorkItem(item.id, { status: 'removed' });
    expect(store.ticketWorkState('ALL-14800')).toBeNull();
  });
});

describe('計畫表的補充資料', () => {
  it('存下來、讀得回來；拿掉全部就是空的', () => {
    const store = new Store(':memory:');
    store.addDrafts([ticket('ALL-1')]);
    store.saveDraftExtras('ALL-1', [{ kind: 'url', value: 'https://x/wiki/pages/1' }, { kind: 'text', value: '照第 17 列做' }]);
    expect(store.listDrafts()[0].extras.map((x) => x.kind)).toEqual(['url', 'text']);
    expect(store.draftExtras('ALL-1')).toHaveLength(2);
    store.saveDraftExtras('ALL-1', []);
    expect(store.draftExtras('ALL-1')).toEqual([]);
  });
});
