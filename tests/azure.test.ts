// 用 Azure 發 PR：讀遠端網址、預設名稱、說明
import { describe, expect, it } from 'vitest';
import { defaultPrTitle, parseAzureRemote, pickReviewers, prDescription } from '../src/main/azure';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { latestPrs } from '../src/shared/types';

describe('Azure 發 PR', () => {
  it('畫面只列每個目標分支最新的 PR：解衝突重發換掉的舊 PR 不列', () => {
    const pr = (id: number, target: string, status: 'active' | 'abandoned' | 'completed' = 'active') => ({ id, url: `u${id}`, target, title: '', status });
    const list = [pr(1, 'version/0.0.1'), pr(2, 'dev', 'abandoned'), pr(3, 'master', 'abandoned'), pr(5, 'dev', 'completed'), pr(4, 'master')];
    expect(latestPrs(list).map((p) => p.id)).toEqual([1, 5, 4]);
  });

  it('設定檔指定審核人：只留這些人（不分大小寫、照設定的順序）；沒指定就全部', () => {
    const all = [
      { id: '1', name: 'AD', email: 'ad@intellianalyze.com' },
      { id: '2', name: 'MCL', email: 'MCL@intellianalyze.com' },
      { id: '3', name: 'KD', email: 'kd@intellianalyze.com' },
    ];
    expect(pickReviewers(all, ['mcl@intellianalyze.com']).map((r) => r.id)).toEqual(['2']);
    expect(pickReviewers(all, ['kd@intellianalyze.com', 'ad@intellianalyze.com', 'nobody@x.com']).map((r) => r.id)).toEqual(['3', '1']);
    expect(pickReviewers(all, undefined)).toBe(all);
    expect(pickReviewers(all, [])).toBe(all);
    expect(parseSettings(DEFAULT_SETTINGS_YAML).prReviewers).toEqual(['mcl@intellianalyze.com']);
  });

  it('讀出組織、專案、repo（兩種網址寫法）；不是 Azure 就是 null', () => {
    expect(parseAzureRemote('https://intellianalyzeorg.visualstudio.com/Platform%20Frontend/_git/PlatformWeb')).toMatchObject({
      orgUrl: 'https://intellianalyzeorg.visualstudio.com', project: 'Platform Frontend', repo: 'PlatformWeb', host: 'intellianalyzeorg.visualstudio.com',
    });
    expect(parseAzureRemote('https://ban@dev.azure.com/org/My%20Proj/_git/Repo')).toMatchObject({ orgUrl: 'https://dev.azure.com/org', project: 'My Proj', repo: 'Repo' });
    expect(parseAzureRemote('https://github.com/a/b.git')).toBeNull();
  });

  it('預設名稱是 feat(單號) 單子名稱；說明帶 Jira 連結和驗收表', () => {
    expect(defaultPrTitle({ ticketKey: 'ALL-14404', ticketSummary: '[FE][In-Game] Adjust padding below game iframe' })).toBe('feat(ALL-14404) [FE][In-Game] Adjust padding below game iframe');
    const text = prDescription({
      ticketKey: 'ALL-14404', ticketSummary: '調整間距', mainKey: 'ALL-14396', mainUrl: 'https://x.atlassian.net/browse/ALL-14396', branch: 'ban/m8/ALL-14404', baseBranch: 'master-8',
      testReport: {
        attention: [], manual: [], otherChanges: [],
        acceptance: [{ no: 1, text: '下方間距跟上方一樣', result: '通過', note: '', change: '下方留白改用 --xs', why: '', files: [], impact: '', howToTest: '開任一遊戲看下方', page: '', needYou: false, checked: false, changed: false }],
      },
    });
    expect(text).toContain('[ALL-14404](https://x.atlassian.net/browse/ALL-14404)');
    expect(text).toContain('主單：[ALL-14396]');
    expect(text).toContain('改了：下方留白改用 --xs');
    expect(text).toContain('怎麼測：開任一遊戲看下方');
    expect(text).not.toContain('Port feature');
  });

  it('移植過來的：說明寫從哪個分支移植', () => {
    const text = prDescription({
      ticketKey: 'ALL-1', ticketSummary: 'x', mainKey: 'ALL-1', mainUrl: '', branch: 'ban/m2/ALL-1', baseBranch: 'master-2', testReport: null,
      portOf: { merchant: 1, branch: 'ban/m1/ALL-1', baseBranch: 'master-1' },
    });
    expect(text).toContain('Port feature from ban/m1/ALL-1 to master-2');
    expect(text).toContain('master-1 -> ban/m1/ALL-1');
    expect(text).toContain('master-2 -> ban/m2/ALL-1');
  });
});
