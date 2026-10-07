import { describe, expect, it } from 'vitest';
import { deriveBranches, normalizeEntry, pickSourceMerchant, planProblem } from '../src/main/planner/rules';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import type { PlanEntry, TicketPlan } from '../src/shared/types';

const settings = parseSettings(DEFAULT_SETTINGS_YAML);

function plan(entries: Partial<PlanEntry>[], key = 'ALL-14734'): TicketPlan {
  return {
    ticket: { key, summary: '', status: '進行中', issueType: '子任務', updated: '', url: '', parent: null },
    entries: entries.map((e) => ({ project: 'PlatformWeb', merchants: [], sourceMerchant: null, reason: '', ...e })),
    skill: 'frontend-workflow',
    prTitle: `feat(${key}) fix username casing`,
    reason: '',
  };
}

describe('來源商戶', () => {
  it('優先順序 m1 > m5 > m8 > 其他（數字小的優先）', () => {
    expect(pickSourceMerchant([2, 5, 8], [1, 5, 8])).toBe(5);
    expect(pickSourceMerchant([1, 9], [1, 5, 8])).toBe(1);
    expect(pickSourceMerchant([8, 10], [1, 5, 8])).toBe(8);
    expect(pickSourceMerchant([10, 2, 7], [1, 5, 8])).toBe(2);
    expect(pickSourceMerchant([], [1, 5, 8])).toBeNull();
  });

  it('整理時去掉不存在的商戶，並保留你指定的來源商戶', () => {
    const rule = settings.projects.PlatformWeb;
    expect(normalizeEntry({ project: 'PlatformWeb', merchants: [7, 2, 3, 2], sourceMerchant: null, reason: '' }, rule)).toMatchObject({ merchants: [2, 7], sourceMerchant: 2 });
    expect(normalizeEntry({ project: 'PlatformWeb', merchants: [1, 7], sourceMerchant: 7, reason: '' }, rule).sourceMerchant).toBe(7);
  });
});

describe('分支展開', () => {
  it('PlatformWeb 單一商戶', () => {
    expect(deriveBranches(plan([{ merchants: [8] }]), settings)).toEqual([
      { ticketKey: 'ALL-14734', project: 'PlatformWeb', merchant: 8, role: 'single', branch: 'ban/m8/ALL-14734', baseBranch: 'master-8', existsIn: [] },
    ]);
  });

  it('PlatformWeb 多商戶：一條來源，其他是移植目標', () => {
    const branches = deriveBranches(plan([{ merchants: [1, 2, 7] }]), settings);
    expect(branches.map((b) => [b.role, b.branch, b.baseBranch])).toEqual([
      ['source', 'ban/m1/ALL-14734', 'master-1'],
      ['target', 'ban/m2/ALL-14734', 'master-2'],
      ['target', 'ban/m7/ALL-14734', 'master-7'],
    ]);
  });

  it('後台專案沒有商戶，單號一律大寫', () => {
    const branches = deriveBranches(plan([{ project: 'PlatformAdmin', merchants: [3] }], 'all-14324'), settings);
    expect(branches).toMatchObject([{ merchant: null, role: 'single', branch: 'ban/ALL-14324', baseBranch: 'version/0.0.1' }]);
  });

  it('一張單牽涉兩個專案，拆成兩條', () => {
    const branches = deriveBranches(plan([{ merchants: [5] }, { project: 'PlatformAdmin' }]), settings);
    expect(branches.map((b) => b.branch)).toEqual(['ban/m5/ALL-14734', 'ban/ALL-14734']);
  });
});

describe('計畫檢查', () => {
  it('填完整才通過', () => {
    expect(planProblem(plan([{ merchants: [8] }]), settings)).toBeNull();
    expect(planProblem(plan([]), settings)).toBe('還沒選專案');
    expect(planProblem(plan([{ merchants: [] }]), settings)).toBe('PlatformWeb 還沒選商戶');
    expect(planProblem(plan([{ merchants: [8] }, { merchants: [1] }]), settings)).toBe('同一個專案出現兩次');
    expect(planProblem({ ...plan([{ merchants: [8] }]), prTitle: '修正' }, settings)).toContain('feat(單號)');
  });
});
