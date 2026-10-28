// 同步基底分支：每 10 分鐘看基底有沒有新提交（只提醒）；按「同步」由 FlowPilot rebase，有衝突交給 AI。用暫存的 git 倉庫，不碰真正的專案。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc } from '../src/main/codex/rpc';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { VSCode } from '../src/main/vscode';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-sync-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'version/0.0.1', remote);
  const folder = join(root, 'PlatformAdmin');
  git(root, 'clone', '-q', remote, folder);
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'a.ts'), 'a\n');
  writeFileSync(join(folder, 'b.ts'), 'b\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'init');
  git(folder, 'push', '-q', 'origin', 'version/0.0.1');
  git(folder, 'switch', '-q', '-c', 'ban/ALL-1');
  writeFileSync(join(folder, 'a.ts'), 'a-mine\n');
  git(folder, 'commit', '-qam', 'work');
  // 別人在基底推了新提交
  const other = join(root, 'other');
  git(root, 'clone', '-q', remote, other);
  const pushBase = (file: string, text: string) => {
    git(other, 'pull', '-q');
    writeFileSync(join(other, file), text);
    git(other, 'commit', '-qam', `base ${file}`);
    git(other, 'push', '-q', 'origin', 'version/0.0.1');
  };

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [{ name: 'PlatformAdmin', path: folder, project: 'PlatformAdmin' }];
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const item = store.createWorkItems([{
    runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformAdmin', merchant: null,
    targetMerchants: [], branch: 'ban/ALL-1', baseBranch: 'version/0.0.1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
  }])[0];
  store.updateWorkItem(item.id, { lane: 'development', status: 'review', stage: 'manual', folder: 'PlatformAdmin', threadId: 'th' });
  const requests: { method: string; params: any }[] = [];
  const codex = {
    on: () => () => {}, setDisconnectHandler: () => {}, start: async () => {}, reply: () => {},
    request: async (method: string, params: any) => (requests.push({ method, params }), method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}),
  } as unknown as CodexRpc;
  const runner = new Runner({
    dataDir: join(root, 'data'), writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4300/', stopSite: () => {},
    store, settings: () => settings, codex, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {}, paused: true,
  });
  const behind = () => runner.board().items.find((i) => i.id === item.id)!.baseBehind;
  return { folder, store, runner, id: item.id, pushBase, behind, requests };
}

describe('同步基底分支', () => {
  it('基底有新提交：檢查後提醒有幾個；按同步就 rebase，沒提交的修改留著，提醒清掉', async () => {
    const t = setup();
    expect(t.behind()).toBeUndefined();
    t.pushBase('b.ts', 'b-new\n');
    await t.runner.checkBaseUpdates();
    expect(t.behind()).toBe(1);
    writeFileSync(join(t.folder, 'c.ts'), 'not committed\n');
    await t.runner.syncBase(t.id);
    expect(readFileSync(join(t.folder, 'b.ts'), 'utf8')).toBe('b-new\n');
    expect(readFileSync(join(t.folder, 'a.ts'), 'utf8')).toBe('a-mine\n');
    expect(readFileSync(join(t.folder, 'c.ts'), 'utf8')).toBe('not committed\n');
    expect(git(t.folder, 'rev-list', '--count', 'HEAD..origin/version/0.0.1')).toBe('0');
    expect(t.behind()).toBeUndefined();
    expect(t.store.getWorkItem(t.id)!.activity).toContain('已 rebase 到最新的 version/0.0.1（1 個新提交）');
  });

  it('有衝突：停在 rebase 中，交給 AI 解（不是 FlowPilot 自己亂合）', async () => {
    const t = setup();
    t.pushBase('a.ts', 'a-theirs\n');
    await t.runner.syncBase(t.id);
    const turn = t.requests.find((r) => r.method === 'turn/start')!;
    expect(turn.params.input[0].text).toContain('## 同步基底分支：解衝突');
    expect(t.store.getWorkItem(t.id)!.activity).toBe('同步基底分支有衝突，請 AI 解衝突');
  });
});
