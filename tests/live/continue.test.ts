// 實測（LIVE=1 才跑）：已存在的分支繼續開發。
// ALL-1：資料夾 A 已經在這條分支、有未提交的修改 → 先問你要不要接著做
// ALL-2：只在資料夾 B 有本機分支，而且本機和遠端各有新提交（分歧）→ 一定分到 B，並先問你
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexRpc } from '../../src/main/codex/rpc';
import { Runner } from '../../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../../src/main/settings';
import { Store } from '../../src/main/store';
import type { VSCode } from '../../src/main/vscode';
import type { JiraTicket } from '../../src/shared/types';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const commit = (cwd: string, message: string) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message);

it.runIf(process.env.LIVE)('已存在的分支繼續開發', { timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-continue-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'master-1', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, '.agents/skills/flowpilot-test'), { recursive: true });
  writeFileSync(
    join(seed, '.agents/skills/flowpilot-test/SKILL.md'),
    '---\nname: flowpilot-test\ndescription: FlowPilot 的測試技能\n---\n\n執行 `git rev-list --count origin/master-1..HEAD`，然後只回覆「基底之後有 N 個提交，完成」並結束，不要做其他事。\n',
  );
  writeFileSync(join(seed, 'package-lock.json'), '{}');
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  git(seed, 'add', '.');
  commit(seed, 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:master-1');
  // 兩條已經存在的分支
  git(seed, 'switch', '-q', '-c', 'ban/m1/ALL-1');
  commit(seed, 'ALL-1 之前的開發');
  git(seed, 'push', '-q', 'origin', 'ban/m1/ALL-1');
  git(seed, 'switch', '-q', 'master-1');
  git(seed, 'switch', '-q', '-c', 'ban/m1/ALL-2');
  commit(seed, 'ALL-2 之前的開發');
  git(seed, 'push', '-q', 'origin', 'ban/m1/ALL-2');

  const a = join(root, 'PlatformWeb');
  const b = join(root, 'PlatformWeb-2');
  for (const dir of [a, b]) {
    git(root, 'clone', '-q', remote, dir);
    mkdirSync(join(dir, 'node_modules'));
  }
  // A：已經在 ALL-1，有未提交的修改
  git(a, 'switch', '-q', 'ban/m1/ALL-1');
  writeFileSync(join(a, 'wip.txt'), '做到一半');
  // B：ALL-2 本機多一個提交，遠端也多一個（分歧），然後切回基底分支
  git(b, 'switch', '-q', 'ban/m1/ALL-2');
  commit(b, 'B 本機的新提交');
  git(b, 'switch', '-q', 'master-1');
  commit(seed, '遠端的新提交');
  git(seed, 'push', '-q', 'origin', 'ban/m1/ALL-2');

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [
    { name: 'PlatformWeb', path: a, project: 'PlatformWeb' },
    { name: 'PlatformWeb-2', path: b, project: 'PlatformWeb' },
  ];
  const store = new Store(join(root, 'test.db'));
  const ticket = (key: string): JiraTicket => ({ key, summary: key, status: '進行中', issueType: '子任務', updated: '', url: `https://example.com/${key}`, parent: null });
  const run = store.createRun([ticket('ALL-1'), ticket('ALL-2')]);
  store.confirmPlan(
    run.id,
    ['ALL-1', 'ALL-2'].map((key) => ({
      ticket: ticket(key),
      entries: [{ project: 'PlatformWeb', merchants: [1], sourceMerchant: 1, reason: '' }],
      skill: 'flowpilot-test',
      prTitle: `feat(${key}) test`,
      reason: '',
    })),
    {},
  );

  const codex = new CodexRpc('daemon');
  const runner = new Runner({
    store,
    settings: () => settings,
    codex,
    vscode: { attach: async () => {} } as unknown as VSCode,
    notify: () => {},
    onChange: () => {},
    onStream: () => {},
    log: (m) => console.log('紀錄', m),
  });
  const item = (key: string) => store.listWorkItems().find((i) => i.ticketKey === key)!;
  const waitFor = async (pred: () => boolean, label: string) => {
    const end = Date.now() + 240_000;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等待逾時：${label}（${JSON.stringify(store.listWorkItems().map((i) => [i.ticketKey, i.status, i.activity]))}）`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  runner.startRun(run.id);
  // 一次只跟一張單對話：先輪到 ALL-1
  await waitFor(() => item('ALL-1').pending?.kind === 'decision', 'ALL-1 問你');
  console.log('ALL-1：', item('ALL-1').folder, item('ALL-1').activity);
  expect(item('ALL-1')).toMatchObject({ folder: 'PlatformWeb', lane: 'conversation', pending: { requestId: 'dirty' } });
  expect(item('ALL-2')).toMatchObject({ lane: 'waiting', status: 'queued' });
  await runner.decide(item('ALL-1').id, 'continue');
  await waitFor(() => item('ALL-1').status === 'review', 'ALL-1 做完');
  expect(item('ALL-2').status).toBe('queued'); // 還沒換下一張，ALL-2 不會開始

  // 換下一張：ALL-1 移到開發佇列，ALL-2 進來對話
  await runner.handOff(item('ALL-1').id);
  expect(item('ALL-1').lane).toBe('development');
  await waitFor(() => item('ALL-2').pending?.kind === 'decision', 'ALL-2 問你');
  console.log('ALL-2：', item('ALL-2').folder, item('ALL-2').activity);
  expect(item('ALL-2')).toMatchObject({ folder: 'PlatformWeb-2', lane: 'conversation', pending: { requestId: 'diverged' } });
  await runner.decide(item('ALL-2').id, 'continue');
  await waitFor(() => item('ALL-2').status === 'review', 'ALL-2 做完');
  console.log('ALL-1 回覆：', item('ALL-1').lastMessage, '｜ALL-2 回覆：', item('ALL-2').lastMessage);
  expect(item('ALL-1').lastMessage).toContain('1');
  expect(item('ALL-2').lastMessage).toContain('2'); // 本機版本：基底之後 2 個提交（之前的 + B 本機的）
  expect(git(a, 'status', '--porcelain')).toContain('wip.txt'); // 未提交的修改還在
  codex.stop();
  store.close();
});
