import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';

describe('發 PR 的目標分支', () => {
  it('{商戶} 展開成每個商戶，照設定的順序；後台只有 version/0.0.1、master、dev', () => {
    const s = parseSettings(DEFAULT_SETTINGS_YAML);
    expect(s.projects.PlatformWeb.prTargets).toEqual([
      ...[1, 2, 5, 7, 8, 9, 10].map((m) => `master-${m}`),
      ...[1, 2, 5, 7, 8, 9, 10].map((m) => `uat-${m}`),
      ...[1, 2, 5, 7, 8, 9, 10].map((m) => `sit-${m}`),
    ]);
    expect(s.projects.PlatformAdmin.prTargets).toEqual(['version/0.0.1', 'master', 'dev']);
    expect(s.projects.GoMoneyAdmin.prTargets).toEqual(['version/0.0.1', 'master', 'dev']);
  });
});
