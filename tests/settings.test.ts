import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_YAML, expandHome, loadSettings, parseSettings } from '../src/main/settings';

describe('設定檔', () => {
  it('預設設定可以解析，並展開 ~', () => {
    const settings = parseSettings(DEFAULT_SETTINGS_YAML);
    expect(settings.jira.envFile).toBe(join(homedir(), 'Desktop/Project/JiraMcpServer/.env'));
    expect(settings.folders.map((f) => f.name)).toEqual(['PlatformWeb', 'PlatformWeb-2', 'PlatformAdmin', 'GoMoneyAdmin']);
    expect(settings.folders[1].path).toBe(join(homedir(), 'Desktop/PlatformWeb-2'));
    expect(settings.projects.PlatformWeb.branch).toBe('ban/m{商戶}/{單號}');
    expect(settings.projects.PlatformWeb.sourcePriority).toEqual([1, 5, 8]);
    expect(settings.projects.GoMoneyAdmin.baseBranch).toBe('version/0.0.1');
  });

  it('檔案不存在時寫入預設內容', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flowpilot-')), '子資料夾', '設定.yaml');
    loadSettings(file);
    expect(readFileSync(file, 'utf8')).toBe(DEFAULT_SETTINGS_YAML);
  });

  it('資料夾指到沒有規則的專案時報錯', () => {
    const text = DEFAULT_SETTINGS_YAML.replace('project: GoMoneyAdmin', 'project: 不存在的專案');
    expect(() => parseSettings(text)).toThrow('沒有分支規則');
  });

  it('只展開開頭的 ~', () => {
    expect(expandHome('/a/~/b')).toBe('/a/~/b');
    expect(expandHome('~')).toBe(homedir());
  });
});
