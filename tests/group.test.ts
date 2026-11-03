// 好幾張單合成一個任務：代表票、單號、PR 名稱與說明、計畫的標題格式
import { describe, expect, it } from 'vitest';
import { defaultPrTitle, prDescription } from '../src/main/azure';
import { planProblem } from '../src/main/planner/rules';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { groupTicket, matchesKey, ticketKeys } from '../src/shared/group';
import type { JiraTicket } from '../src/shared/types';

const parent = { key: 'ALL-14795', summary: '[M10] 內部測試問題修正', url: 'https://x/browse/ALL-14795' };
const t = (key: string, p: JiraTicket['parent'] = parent): JiraTicket => ({ key, summary: `${key} 標題`, status: '', issueType: '', updated: '', url: `https://x/browse/${key}`, parent: p });

describe('合成一個任務', () => {
  it('主單是單號最小的；同一張上層主單就用它的標題；不同就寫「等 N 張」', () => {
    const g = groupTicket([t('ALL-14800'), t('ALL-14798'), t('ALL-14799')]);
    expect(g.key).toBe('ALL-14798');
    expect(g.summary).toBe('[M10] 內部測試問題修正');
    expect(ticketKeys(g)).toBe('ALL-14798, ALL-14799, ALL-14800');
    expect(groupTicket([t('ALL-2', null), t('ALL-1', null)]).summary).toBe('ALL-1 標題 等 2 張');
    expect(() => groupTicket([t('ALL-1')])).toThrow('至少要兩張');
  });

  it('標題可以有好幾個單號；PR 名稱和說明列出全部單', () => {
    const settings = parseSettings(DEFAULT_SETTINGS_YAML);
    const g = groupTicket([t('ALL-14800'), t('ALL-14798')]);
    const plan = { ticket: g, entries: [{ project: 'PlatformWeb', merchants: [10], sourceMerchant: 10, reason: '' }], prTitle: 'feat(ALL-14798, ALL-14800) fix profile', reason: '' };
    expect(planProblem(plan, settings)).toBeNull();
    const members = g.members!.map((m) => ({ key: m.key, summary: m.summary, url: m.url }));
    expect(defaultPrTitle({ ticketKey: g.key, ticketSummary: g.summary, members })).toBe('feat(ALL-14798, ALL-14800) [M10] 內部測試問題修正');
    const text = prDescription({ ticketKey: g.key, ticketSummary: g.summary, mainKey: 'ALL-14795', mainUrl: parent.url, branch: 'ban/m10/ALL-14798', baseBranch: 'master-10', testReport: null, members });
    expect(text).toContain('- [ALL-14798](https://x/browse/ALL-14798)');
    expect(text).toContain('- [ALL-14800](https://x/browse/ALL-14800)');
  });
});

describe('作戰室搜尋單號', () => {
  it('不分大小寫、只打數字也行、空白不算；合成任務的成員單號也找得到；空的全部符合', () => {
    const one = { ticketKey: 'ALL-14597', members: [] };
    const group = { ticketKey: 'ALL-14796', members: [{ key: 'ALL-14796' }, { key: 'ALL-14805' }] };
    expect(matchesKey(one, '14597')).toBe(true);
    expect(matchesKey(one, 'all-14597')).toBe(true);
    expect(matchesKey(one, ' ALL 145 ')).toBe(true);
    expect(matchesKey(one, '14805')).toBe(false);
    expect(matchesKey(group, '14805')).toBe(true);
    expect(matchesKey(one, '  ')).toBe(true);
  });
});
