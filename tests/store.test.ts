import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/main/store';
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
      'ALL-1': { entries: [entry([8])], prTitle: '', reason: '' },
      'ALL-2': { entries: [entry([5])], prTitle: '', reason: '' },
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
