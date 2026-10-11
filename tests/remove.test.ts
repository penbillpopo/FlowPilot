// 移除時順便刪本機分支：只刪本機、有沒提交的修改就不刪、AI 執行中不能刪。用暫存的 git 倉庫，不碰真正的專案。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc } from '../src/main/codex/rpc';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { VSCode } from '../src/main/vscode';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-remove-'));
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
  // 這張單的分支：一個還沒推送的提交
  git(folder, 'switch', '-q', '-c', 'ban/ALL-1');
  writeFileSync(join(folder, 'a.ts'), 'a2\n');
  git(folder, 'commit', '-qam', 'work');

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [{ name: 'PlatformAdmin', path: folder, project: 'PlatformAdmin' }];
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const item = store.createWorkItems([{
    runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformAdmin', merchant: null,
    targetMerchants: [], branch: 'ban/ALL-1', baseBranch: 'version/0.0.1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
  }])[0];
  store.updateWorkItem(item.id, { lane: 'development', status: 'review', folder: 'PlatformAdmin', threadId: 'th' });
  const runner = new Runner({
    dataDir: join(root, 'data'), writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4300/',
    store, settings: () => settings, codex: { on: () => () => {}, setDisconnectHandler: () => {} } as unknown as CodexRpc, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  const branches = () => git(folder, 'branch', '--format=%(refname:short)').split('\n');
  return { folder, store, runner, id: item.id, branches };
}

describe('移除時刪除本機分支', () => {
  it('有還沒推送的提交也照樣刪：先還原 environment.ts、切回基底，再刪；遠端不動', async () => {
    const t = setup();
    writeFileSync(join(t.folder, 'src/environments/environment.ts'), "/** SIT */\n// apiUrl: 'sit',\n/** UAT */\napiUrl: 'uat',\n");
    expect(await t.runner.branchInfo(t.id)).toMatchObject({ exists: true, hasRemote: false, unpushed: 1, dirty: [] });
    expect(await t.runner.remove(t.id, true)).toEqual({ branchDeleted: true });
    expect(t.branches()).toEqual(['version/0.0.1']);
    expect(git(t.folder, 'branch', '--show-current')).toBe('version/0.0.1');
    expect(git(t.folder, 'status', '--porcelain')).toBe('');
    expect(t.store.getWorkItem(t.id)?.status).toBe('removed');
  });

  it('有沒提交的修改就不刪分支，只移除，並說明原因', async () => {
    const t = setup();
    writeFileSync(join(t.folder, 'a.ts'), 'a3\n');
    const result = await t.runner.remove(t.id, true);
    expect(result.branchDeleted).toBe(false);
    expect(result.reason).toContain('沒提交的修改');
    expect(t.branches()).toContain('ban/ALL-1');
    expect(git(t.folder, 'branch', '--show-current')).toBe('ban/ALL-1');
    expect(t.store.getWorkItem(t.id)?.status).toBe('removed');
  });

  it('不勾刪分支就跟以前一樣不動分支；AI 執行中不能刪', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { status: 'running' });
    await expect(t.runner.remove(t.id, true)).rejects.toThrow('AI 還在執行');
    expect(t.store.getWorkItem(t.id)?.status).toBe('running');
    t.store.updateWorkItem(t.id, { status: 'review' });
    expect(await t.runner.remove(t.id)).toEqual({ branchDeleted: false });
    expect(t.branches()).toContain('ban/ALL-1');
  });
});
