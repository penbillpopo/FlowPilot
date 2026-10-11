// 實測（LIVE=1 才跑）：更新需求。用真實 Jira 單的內容比對，交給測試倉庫裡的 AI，看它在對話裡怎麼回答。
// 只讀 Jira；AI 在暫存的 git 倉庫裡，不會碰到真正的專案。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexRpc } from '../../src/main/codex/rpc';
import { getIssueContext, loadCredentials } from '../../src/main/jira';
import { diffSnapshots, updateMessage } from '../../src/main/requirements';
import { Runner } from '../../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, loadSettings, parseSettings } from '../../src/main/settings';
import { Store } from '../../src/main/store';
import type { VSCode } from '../../src/main/vscode';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

it.runIf(process.env.LIVE)('更新需求：沒有變更、有變更', { timeout: 600_000 }, async () => {
  // 測試倉庫＋一個只會回覆「好」的測試技能
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-req-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'master-1', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, '.agents/skills/flowpilot-test'), { recursive: true });
  writeFileSync(join(seed, '.agents/skills/flowpilot-test/SKILL.md'), '---\nname: flowpilot-test\ndescription: 測試技能\n---\n\n只回覆「好」，不要做其他事。\n');
  writeFileSync(join(seed, 'package-lock.json'), '{}');
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:master-1');
  const folder = join(root, 'PlatformWeb');
  git(root, 'clone', '-q', remote, folder);
  mkdirSync(join(folder, 'node_modules'));

  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.projects.PlatformWeb.devSkill = 'flowpilot-test'; // 開發技能看設定檔
  settings.folders = [{ name: 'PlatformWeb', path: folder, project: 'PlatformWeb' }];
  const store = new Store(join(root, 'test.db'));
  const ticket = { key: 'ALL-14404', summary: 'Adjust padding below game iframe', status: '進行中', issueType: '子任務', updated: '', url: '', parent: null };
  const run = store.createRun([ticket]);
  store.confirmPlan(run.id, [{ ticket, entries: [{ project: 'PlatformWeb', merchants: [1], sourceMerchant: 1, reason: '' }], skill: 'flowpilot-test', prTitle: 'feat(ALL-14404) x', reason: '' }], {});
  const codex = new CodexRpc('daemon');
  const runner = new Runner({
    dataDir: root, ensureSite: async () => 'http://localhost:4200/',
    store, settings: () => settings, codex, vscode: { attach: async () => {} } as unknown as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: (m) => console.log('紀錄', m),
  });
  const item = () => store.listWorkItems()[0];
  const waitIdle = async (label: string) => {
    const end = Date.now() + 240_000;
    await new Promise((r) => setTimeout(r, 1500));
    while (!['waiting', 'review'].includes(item().status)) {
      if (Date.now() > end) throw new Error(`等待逾時：${label}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  runner.startRun(run.id);
  await waitIdle('技能回覆');

  // 真實 Jira 的內容
  const real = loadSettings(`${process.env.HOME}/Library/Application Support/FlowPilot/設定.yaml`);
  const credentials = loadCredentials(real.jira.envFile);
  const fresh = [(await getIssueContext(credentials, 'ALL-14404')).snapshot, (await getIssueContext(credentials, 'ALL-14396')).snapshot];

  // 1. 沒有變更：快照跟現在一樣
  await runner.reply(item().id, updateMessage(diffSnapshots(fresh, fresh, 'ALL-14404'), fresh));
  await waitIdle('沒有變更的回覆');
  console.log('沒有變更時 AI 回覆：', item().lastMessage);
  expect(item().lastMessage).toContain('這個需求沒有變更');

  // 2. 有變更：拿一份舊的快照（主單內文少了一行）來比
  const old = fresh.map((s) => (s.key === 'ALL-14396' ? { ...s, description: s.description.split('\n').slice(0, -3).join('\n') } : s));
  const changes = diffSnapshots(old, fresh, 'ALL-14404');
  expect(changes.length).toBeGreaterThan(0);
  await runner.reply(item().id, updateMessage(changes, fresh));
  await waitIdle('有變更的回覆');
  console.log('有變更時 AI 回覆：\n', item().lastMessage);
  expect(item().lastMessage).not.toContain('這個需求沒有變更');
  expect(git(folder, 'status', '--porcelain').trim()).toBe(''); // 先不改檔案
  codex.stop();
  store.close();
});
