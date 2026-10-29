// 先交付、待補測：讓出資料夾、欠的測試留著；繼續修要拿得到空的資料夾才行；欠測試不能完成。用暫存的 git 倉庫，不碰真正的專案。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc } from '../src/main/codex/rpc';
import { branchHasWork, Runner } from '../src/main/runner/runner';
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
  return { root, remote, folder, settings, store, runner, id: item.id, make, stopped };
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

  it('已完成的單退回作戰中：切回分支、拿回資料夾，不補測的記號清掉；同一條分支已經有別張卡片在作戰中就不行', async () => {
    const t = setup();
    await t.runner.park(t.id);
    await t.runner.finish(t.id, true, true);
    git(t.folder, 'switch', '-q', 'version/0.0.1');
    await t.runner.resume(t.id);
    const back = t.store.getWorkItem(t.id)!;
    expect(back).toMatchObject({ status: 'review', lane: 'development', stage: 'manual', folder: 'PlatformAdmin', threadId: 'th' });
    expect(back.testReport?.finishedUntested).toBeUndefined();
    expect(back.activity).toContain('退回作戰中');
    expect(git(t.folder, 'branch', '--show-current')).toBe('ban/ALL-1');

    const u = setup();
    await u.runner.park(u.id);
    await u.runner.finish(u.id, true, true);
    const again = u.make('ALL-1', 'ban/ALL-1');
    u.store.updateWorkItem(again.id, { status: 'review', folder: 'PlatformAdmin' });
    await expect(u.runner.resume(u.id)).rejects.toThrow('已經有另一張卡片在作戰中');
  });
});

describe('資料夾不在這張單的分支', () => {
  it('被切走了：不能跟 AI 說話、不能完成；切回之後就好。有沒提交的改動先說是哪些、不切', async () => {
    const t = setup();
    t.runner.setChecked(t.id, 1, true);
    git(t.folder, 'switch', '-q', 'version/0.0.1');
    await expect(t.runner.reply(t.id, '繼續')).rejects.toThrow('不是這張單的分支 ban/ALL-1');
    await expect(t.runner.finish(t.id, true)).rejects.toThrow('不是這張單的分支 ban/ALL-1');

    writeFileSync(join(t.folder, 'a.ts'), 'mine\n');
    await expect(t.runner.switchBack(t.id)).rejects.toThrow('PlatformAdmin 現在在 version/0.0.1，有 1 個沒提交的改動（a.ts）');
    expect(git(t.folder, 'branch', '--show-current')).toBe('version/0.0.1');

    git(t.folder, 'checkout', '--', 'a.ts');
    await t.runner.switchBack(t.id);
    expect(git(t.folder, 'branch', '--show-current')).toBe('ban/ALL-1');
    await t.runner.finish(t.id, true);
    expect(t.store.getWorkItem(t.id)!.status).toBe('committed');
  });

  it('在退役的資料夾被切走：搬到 FlowPilot 的資料夾，沒推送的提交一起帶過去，原本的資料夾不動', async () => {
    const t = setup();
    const mine = join(t.root, 'FlowPilot-PlatformAdmin');
    git(t.root, 'clone', '-q', t.remote, mine);
    t.settings.folders = [
      { name: 'PlatformAdmin-1', path: mine, project: 'PlatformAdmin' },
      { name: 'PlatformAdmin', path: t.folder, project: 'PlatformAdmin', retired: true },
    ];
    git(t.folder, 'switch', '-q', '-c', 'ban/fix-ui');
    writeFileSync(join(t.folder, 'a.ts'), 'my own work\n'); // 你自己在做的，不能被動到

    await t.runner.relocate(t.id);
    expect(t.store.getWorkItem(t.id)).toMatchObject({ folder: 'PlatformAdmin-1', status: 'review', threadId: 'th' });
    expect(git(mine, 'branch', '--show-current')).toBe('ban/ALL-1');
    expect(git(mine, 'log', '-1', '--format=%s')).toBe('work'); // 沒推送的提交也帶過來了
    expect(git(t.folder, 'branch', '--show-current')).toBe('ban/fix-ui');
    expect(git(t.folder, 'status', '--porcelain')).toBe('M a.ts');
  });

  it('退役資料夾裡的同名分支：空的不算（直接開新的），有提交或沒提交的修改才算', async () => {
    const t = setup();
    git(t.folder, 'fetch', '-q', 'origin');
    expect(await branchHasWork(t.folder, 'ban/ALL-1', 'version/0.0.1')).toBe(true); // 有自己的提交
    git(t.folder, 'branch', 'ban/ALL-2', 'origin/version/0.0.1');
    expect(await branchHasWork(t.folder, 'ban/ALL-2', 'version/0.0.1')).toBe(false); // 只是開過的空分支
    git(t.folder, 'switch', '-q', 'ban/ALL-2');
    writeFileSync(join(t.folder, 'src/environments/environment.ts'), "/** SIT */\n// apiUrl: 'sit',\n/** UAT */\napiUrl: 'uat',\n");
    expect(await branchHasWork(t.folder, 'ban/ALL-2', 'version/0.0.1')).toBe(false); // 只有切環境的改動不算
    writeFileSync(join(t.folder, 'b.ts'), 'new\n');
    expect(await branchHasWork(t.folder, 'ban/ALL-2', 'version/0.0.1')).toBe(true); // 切在上面、有沒提交的新檔案
    expect(await branchHasWork(t.folder, 'ban/ALL-2', 'no-such-base')).toBe(true); // 算不出來：擋下來
  });

  it('繼續修不會拿退役的資料夾', async () => {
    const t = setup();
    await t.runner.park(t.id);
    t.settings.folders = [{ name: 'PlatformAdmin', path: t.folder, project: 'PlatformAdmin', retired: true }];
    await expect(t.runner.resume(t.id)).rejects.toThrow('資料夾都在用');
  });
});
