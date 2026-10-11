// 開發前 rebase 到最新的基底：沒衝突直接完成；有衝突停在 rebase 中交給 AI 解；推送時判斷要不要強制推送
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc, RpcMessage } from '../src/main/codex/rpc';
import { gitState } from '../src/main/gitpanel';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { VSCode } from '../src/main/vscode';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function setup(conflict: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-rebase-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'version/0.0.1', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'a.ts'), 'a\n');
  writeFileSync(join(seed, 'package-lock.json'), '{}');
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'push', '-q', 'origin', 'version/0.0.1');
  // 這張單的分支：改了 a.ts，推送過
  git(seed, 'switch', '-qc', 'ban/ALL-1');
  writeFileSync(join(seed, 'a.ts'), 'mine\n');
  git(seed, 'commit', '-qam', 'work');
  git(seed, 'push', '-q', 'origin', 'ban/ALL-1');
  const folder = join(root, 'PlatformAdmin');
  git(root, 'clone', '-q', remote, folder);
  git(folder, 'switch', '-q', 'ban/ALL-1');
  mkdirSync(join(folder, 'node_modules'));
  // 之後基底有人推了新提交（衝突的話改同一個檔案）
  git(seed, 'switch', '-q', 'version/0.0.1');
  writeFileSync(join(seed, conflict ? 'a.ts' : 'b.ts'), 'theirs\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'base moved');
  git(seed, 'push', '-q', 'origin', 'version/0.0.1');

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [{ name: 'PlatformAdmin', path: folder, project: 'PlatformAdmin' }];
  const requests: { method: string; params: any }[] = [];
  const codex = {
    on: (_l: (m: RpcMessage) => void) => () => {},
    setDisconnectHandler: () => {},
    start: async () => {},
    reply: () => {},
    request: async (method: string, params: any) => {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'th' } };
      if (method === 'turn/start') return { turn: { id: 'tu' } };
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'frontend-development', description: '', path: '/s/SKILL.md', enabled: true }] }] };
      return {};
    },
  } as unknown as CodexRpc;
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  store.createWorkItems([{
    runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformAdmin', merchant: null,
    targetMerchants: [], branch: 'ban/ALL-1', baseBranch: 'version/0.0.1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
  }]);
  const runner = new Runner({
    dataDir: join(root, 'data'), writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4300/',
    store, settings: () => settings, codex, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  const instructions = () => requests.filter((r) => r.method === 'turn/start').at(-1)?.params.input[1].text as string | undefined;
  const waitStarted = async () => {
    for (let i = 0; i < 100 && !instructions(); i++) await new Promise((r) => setTimeout(r, 100));
  };
  return { folder, store, runner, requests, instructions, waitStarted, run };
}

describe('開發前 rebase 到最新的基底', () => {
  it('沒有衝突：rebase 完成，指示裡說明；遠端歷史不同，推送要強制', async () => {
    const t = setup(false);
    await t.runner.schedule();
    await t.waitStarted();
    expect(t.instructions()).toContain('已經把分支 rebase 到最新的 origin/version/0.0.1');
    expect(git(t.folder, 'log', '--format=%s', '-3').split('\n')).toEqual(['work', 'base moved', 'init']);
    expect((await gitState(t.folder)).needsForce).toBe(true);
  }, 30_000);

  it('有衝突：停在 rebase 中，指示最前面要 AI 先解衝突再開發', async () => {
    const t = setup(true);
    await t.runner.schedule();
    await t.waitStarted();
    expect(t.instructions()).toContain('【先處理】');
    expect(t.instructions()).toContain('GIT_EDITOR=true git rebase --continue');
    expect(existsSync(join(t.folder, '.git', 'rebase-merge')) || existsSync(join(t.folder, '.git', 'rebase-apply'))).toBe(true);
  }, 30_000);

  it('同一條分支、同一個資料夾以前做過：接回原本的對話', async () => {
    const t = setup(false);
    // 以前做過、後來移除的那一筆
    const [old] = t.store.createWorkItems([{
      runId: t.run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformAdmin', merchant: null,
      targetMerchants: [], branch: 'ban/ALL-1', baseBranch: 'version/0.0.1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
    }]);
    t.store.updateWorkItem(old.id, { status: 'removed', lane: 'done', folder: 'PlatformAdmin', threadId: 'old-thread' });
    await t.runner.schedule();
    await t.waitStarted();
    expect(t.requests.some((r) => r.method === 'thread/resume' && r.params.threadId === 'old-thread')).toBe(true);
    expect(t.requests.some((r) => r.method === 'thread/start')).toBe(false);
    expect(t.requests.filter((r) => r.method === 'turn/start').at(-1)?.params.threadId).toBe('old-thread');
    expect(t.instructions()).toContain('這是接續之前的對話');
  }, 30_000);
});
