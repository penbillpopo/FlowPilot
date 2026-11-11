// 多商戶的單：來源商戶完成後移植到其他商戶。用暫存的 git 倉庫，不碰真正的專案。
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

function setup(pushSource: boolean, opts: { envDirty?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-port-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'master-1', remote);
  const folder = join(root, 'PlatformWeb');
  git(root, 'clone', '-q', remote, folder);
  git(folder, 'config', 'user.name', 't');
  git(folder, 'config', 'user.email', 't@t');
  writeFileSync(join(folder, 'a.ts'), 'a\n');
  mkdirSync(join(folder, 'src/environments'), { recursive: true });
  writeFileSync(join(folder, 'src/environments/environment.ts'), "// sit分支本地调试使用这个\nconst apiUrl = 'sit';\n// uat分支本地调试使用这个\n// const apiUrl = 'uat';\n");
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'init');
  git(folder, 'push', '-q', 'origin', 'master-1');
  // m2、m7 的基底分支
  for (const b of ['master-2', 'master-7']) git(folder, 'push', '-q', 'origin', `master-1:${b}`);
  git(folder, 'switch', '-q', '-c', 'ban/m1/ALL-1');
  writeFileSync(join(folder, 'a.ts'), 'a2\n');
  git(folder, 'commit', '-qam', 'work');
  if (pushSource) git(folder, 'push', '-q', 'origin', 'ban/m1/ALL-1');
  git(folder, 'switch', '-q', 'master-1');
  if (opts.envDirty) writeFileSync(join(folder, 'src/environments/environment.ts'), "// sit分支本地调试使用这个\n// const apiUrl = 'sit';\n// uat分支本地调试使用这个\nconst apiUrl = 'uat';\n");

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [{ name: 'PlatformWeb', path: folder, project: 'PlatformWeb' }];
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const item = store.createWorkItems([{
    runId: run.id, ticketKey: 'ALL-1', ticketSummary: '刪除按鈕', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformWeb', merchant: 1,
    targetMerchants: [2, 7], branch: 'ban/m1/ALL-1', baseBranch: 'master-1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
  }])[0];
  const runner = new Runner({
    dataDir: join(root, 'data'), writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4200/',
    store, settings: () => settings, codex: { on: () => () => {}, setDisconnectHandler: () => {}, start: async () => { throw new Error('測試沒有 Codex'); } } as unknown as CodexRpc, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  // 排程（準備好之後要開 AI 對話的那一步，假的 Codex 會失敗，不影響要測的分配資料夾、還原檔案、建立分支）
  const start = async () => {
    await runner.schedule();
    await new Promise((r) => setTimeout(r, 1500));
  };
  return { store, runner, id: item.id, folder, start, root, settings };
}

describe('移植到其他商戶', () => {
  it('來源完成、也推送了：每個商戶建一張新的工作，記下來源分支；再按一次不會重複建', async () => {
    const t = setup(true);
    await expect(t.runner.port(t.id)).rejects.toThrow('要先完成');
    t.store.updateWorkItem(t.id, { status: 'committed' });
    expect(await t.runner.port(t.id)).toEqual(['ban/m2/ALL-1', 'ban/m7/ALL-1']);
    const ported = t.store.listWorkItems().filter((i) => i.portOf);
    expect(ported.map((i) => [i.merchant, i.branch, i.baseBranch, i.status])).toEqual([[2, 'ban/m2/ALL-1', 'master-2', 'queued'], [7, 'ban/m7/ALL-1', 'master-7', 'queued']]);
    expect(ported[0].portOf).toEqual({ merchant: 1, branch: 'ban/m1/ALL-1', baseBranch: 'master-1' });
    expect(ported[0].skill).toBe('platform-web-copy');
    await expect(t.runner.port(t.id)).rejects.toThrow('都已經在工作台上');
  });

  it('資料夾只有 environment.ts 改過（測試切環境留下的）：照樣分配給移植的單，並還原那個檔案', async () => {
    const t = setup(true, { envDirty: true });
    t.store.updateWorkItem(t.id, { status: 'committed' });
    await t.runner.port(t.id);
    await t.start();
    const m2 = t.store.listWorkItems().find((i) => i.merchant === 2)!;
    expect(m2.activity).not.toContain('未提交的修改');
    expect(m2.folder).toBe('PlatformWeb');
    expect(git(t.folder, 'status', '--porcelain', '--', 'src')).toBe(''); // environment.ts 已還原
    // 資料夾最後停在哪條分支看時間（m7 可能接著切過去），只確認 m2 的分支建好了
    expect(git(t.folder, 'branch', '--list', 'ban/m2/ALL-1')).toContain('ban/m2/ALL-1');
  });

  it('來源還沒推送也可以移植：從本機有這條分支的資料夾抓過去（拿得到沒推送的提交）', async () => {
    const t = setup(false);
    t.store.updateWorkItem(t.id, { status: 'committed' });
    expect(await t.runner.port(t.id)).toEqual(['ban/m2/ALL-1', 'ban/m7/ALL-1']);
    // 另一個資料夾（例如 PlatformWeb-2）抓來源
    const other = join(t.root, 'PlatformWeb-2');
    git(t.root, 'clone', '-q', join(t.root, 'remote.git'), other);
    t.settings.folders.push({ name: 'PlatformWeb-2', path: other, project: 'PlatformWeb' });
    const src = { merchant: 1, branch: 'ban/m1/ALL-1', baseBranch: 'master-1' };
    const ref = await (t.runner as unknown as { fetchPortSource(cwd: string, project: string, s: typeof src): Promise<string> }).fetchPortSource(other, 'PlatformWeb', src);
    expect(ref).toBe('refs/flowpilot-source/ban/m1/ALL-1');
    expect(git(other, 'rev-parse', ref)).toBe(git(t.folder, 'rev-parse', 'ban/m1/ALL-1'));
    expect(git(other, 'diff', '--name-only', `origin/master-1...${ref}`)).toBe('a.ts');
  });

  it('來源分支比基底沒有任何提交（AI 沒真的開發）：不能移植', async () => {
    const t = setup(false);
    t.store.updateWorkItem(t.id, { status: 'committed' });
    git(t.folder, 'branch', '-f', 'ban/m1/ALL-1', 'master-1');
    await expect(t.runner.port(t.id)).rejects.toThrow('沒有東西可以移植');
    expect(t.store.listWorkItems().filter((i) => i.portOf)).toEqual([]);
  });

  it('本機和遠端都沒有來源分支：不能移植', async () => {
    const t = setup(false);
    t.store.updateWorkItem(t.id, { status: 'committed' });
    git(t.folder, 'branch', '-D', 'ban/m1/ALL-1');
    await expect(t.runner.port(t.id)).rejects.toThrow('本機的資料夾和遠端都沒有');
  });
});
