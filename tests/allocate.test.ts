import { describe, expect, it } from 'vitest';
import { merchantOfBranch, pickFolder } from '../src/main/runner/allocate';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';

const settings = parseSettings(DEFAULT_SETTINGS_YAML);
const web = settings.projects.PlatformWeb;

describe('分配資料夾', () => {
  it('從分支名稱看出商戶', () => {
    expect(merchantOfBranch('ban/m8/ALL-14699')).toBe(8);
    expect(merchantOfBranch('master-5')).toBe(5);
    expect(merchantOfBranch('ban/ALL-1')).toBeNull();
    expect(merchantOfBranch('multi-tenant')).toBeNull();
  });

  it('只挑同專案、空著的資料夾', () => {
    expect(pickFolder({ project: 'PlatformAdmin', merchant: null }, settings.folders, new Set(), {}, settings.projects.PlatformAdmin)?.name).toBe('PlatformAdmin');
    expect(pickFolder({ project: 'PlatformAdmin', merchant: null }, settings.folders, new Set(['PlatformAdmin']), {}, settings.projects.PlatformAdmin)).toBeNull();
    expect(pickFolder({ project: 'PlatformWeb', merchant: 8 }, settings.folders, new Set(['PlatformWeb']), {}, web)?.name).toBe('PlatformWeb-2');
  });

  it('PlatformWeb 優先挑同套件群組的資料夾', () => {
    const branches = { PlatformWeb: 'ban/m8/ALL-1', 'PlatformWeb-2': 'ban/m5/ALL-2' };
    expect(pickFolder({ project: 'PlatformWeb', merchant: 9 }, settings.folders, new Set(), branches, web)?.name).toBe('PlatformWeb-2');
    expect(pickFolder({ project: 'PlatformWeb', merchant: 1 }, settings.folders, new Set(), branches, web)?.name).toBe('PlatformWeb');
    // 分支已經在 PlatformWeb-2：一定用它；它被佔用就排隊
    expect(pickFolder({ project: 'PlatformWeb', merchant: 1 }, settings.folders, new Set(), branches, web, 'PlatformWeb-2')?.name).toBe('PlatformWeb-2');
    expect(pickFolder({ project: 'PlatformWeb', merchant: 1 }, settings.folders, new Set(['PlatformWeb-2']), branches, web, 'PlatformWeb-2')).toBeNull();
    // 商戶 10 還沒分群組：挑第一個空的
    expect(pickFolder({ project: 'PlatformWeb', merchant: 10 }, settings.folders, new Set(), branches, web)?.name).toBe('PlatformWeb');
  });
});
