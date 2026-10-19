// 先交付、待補測：讓出資料夾、欠的測試留著；繼續修要拿得到空的資料夾才行；欠測試不能完成。用暫存的 git 倉庫，不碰真正的專案。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc } from '../src/main/codex/rpc';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { TestReport } from '../src/shared/types';
import type { VSCode } from '../src/main/vscode';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const report = (checked: boolean): TestReport => ({
  attention: [], otherChanges: [], manual: [],
  acceptance: [{ no: 1, text: '按鈕顯示', result: '沒測', note: '', change: '', why: '', files: [], impact: '', howToTest: '', page: '', needYou: true, checked, changed: false }],
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-park-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'version/0.0.1', remote);
  const folder = join(root, 'PlatformAdmin');
  git(root, 'clone', '-q', remote, folder);
  git(folder, 'config', 'user.name', 't');
  git(folder, 'config', 'user.email', 't@t');
  mkdirSync(join(folder, 'src/environments'), { recursive: true });
  writeFileSync(join(folder, 'src/environments/environment.ts'), "/** SIT */\napiUrl: 'sit',\n/** UAT */\n// apiUrl: 'uat',\n");
  writeFileSync(join(folder, 'a.ts'), 'a\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'init');
  git(folder, 'push', '-q', 'origin', 'version/0.0.1');
  git(folder, 'switch', '-q', '-c', 'ban/ALL-1');
  writeFileSync(join(folder, 'a.ts'), 'a2\n');
  git(folder, 'commit', '-qam', 'work');

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [{ name: 'PlatformAdmin', path: folder, project: 'PlatformAdmin' }];
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const make = (key: string, branch: string) => store.createWorkItems([{
    runId: run.id, ticketKey: key, ticketSummary: '', mainKey: key, mainUrl: '', project: 'PlatformAdmin', merchant: null,
    targetMerchants: [], branch, baseBranch: 'version/0.0.1', skill: 'x', prTitle: `feat(${key}) x`, preferredFolder: null,
  }])[0];
  const item = make('ALL-1', 'ban/ALL-1');
  store.updateWorkItem(item.id, { lane: 'development', status: 'review', stage: 'manual', folder: 'PlatformAdmin', threadId: 'th', testReport: report(false) });
  const stopped: string[] = [];
  const runner = new Runner({
    dataDir: join(root, 'data'), writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4300/', stopSite: (n) => stopped.push(n),
    store, settings: () => settings, codex: { on: () => () => {}, setDisconnectHandler: () => {} } as unknown as CodexRpc, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {}, paused: true,
  });
  return { folder, store, runner, id: item.id, make, stopped };
}

describe('先交付、待補測', () => {
  it('欠測試不能完成；先交付要改動都提交了；交付後讓出資料夾，欠的測試留著', async () => {
    const t = setup();
    await expect(t.runner.finish(t.id, true)).rejects.toThrow('還有 1 項測試沒勾');
    writeFileSync(join(t.folder, 'a.ts'), 'a3\n');
    await expect(t.runner.park(t.id)).rejects.toThrow('沒提交的改動');
    git(t.folder, 'commit', '-qam', 'more');
    // 測試切環境留下的 environment.ts 會還原，不擋
    writeFileSync(join(t.folder, 'src/environments/environment.ts'), "/** SIT */\n// apiUrl: 'sit',\n/** UAT */\napiUrl: 'uat',\n");
    await t.runner.park(t.id);
    expect(t.store.getWorkItem(t.id)).toMatchObject({ status: 'parked', folder: null });
    expect(t.store.getWorkItem(t.id)!.testReport?.acceptance[0].checked).toBe(false);
    expect(t.store.ticketWorkState('ALL-1')).toBe('active');
    expect(t.stopped).toEqual(['PlatformAdmin']);
    expect(git(t.folder, 'status', '--porcelain')).toBe('');
  });

  it('繼續修：資料夾都在用就鎖住、說出哪張單在用；空出來才切回分支', async () => {
    const t = setup();
    await t.runner.park(t.id);
    git(t.folder, 'switch', '-q', 'version/0.0.1');
    const other = t.make('ALL-2', 'ban/ALL-2');
    t.store.updateWorkItem(other.id, { status: 'review', folder: 'PlatformAdmin' });
    await expect(t.runner.resume(t.id)).rejects.toThrow('資料夾都在用（PlatformAdmin 在做 ALL-2）');
    expect(t.store.getWorkItem(t.id)!.status).toBe('parked');
    t.store.updateWorkItem(other.id, { status: 'committed' });
    await t.runner.resume(t.id);
    expect(t.store.getWorkItem(t.id)).toMatchObject({ status: 'review', folder: 'PlatformAdmin', stage: 'manual' });
    expect(git(t.folder, 'branch', '--show-current')).toBe('ban/ALL-1');
  });

  it('直接完成（不補測）：欠的測試不擋，但記在驗收表上、狀態寫明幾項沒測；重開 FlowPilot 讀回來也還在', async () => {
    const t = setup();
    await t.runner.park(t.id);
    await t.runner.finish(t.id, true, true);
    const done = t.store.getWorkItem(t.id)!;
    expect(done.status).toBe('committed');
    expect(done.testReport?.finishedUntested).toBe(1);
    expect(done.testReport?.acceptance[0].checked).toBe(false);
    expect(done.activity).toContain('1 項沒測就完成');
  });

  it('補測完就能完成；移除待補測的單會刪掉原本資料夾裡的分支', async () => {
    const t = setup();
    await t.runner.park(t.id);
    t.runner.setChecked(t.id, 1, true);
    await t.runner.finish(t.id, true);
    expect(t.store.getWorkItem(t.id)!.status).toBe('committed');

    const u = setup();
    await u.runner.park(u.id);
    git(u.folder, 'switch', '-q', 'version/0.0.1');
    expect(await u.runner.remove(u.id)).toEqual({ branchDeleted: true });
    expect(git(u.folder, 'branch', '--format=%(refname:short)')).toBe('version/0.0.1');
  });
});
