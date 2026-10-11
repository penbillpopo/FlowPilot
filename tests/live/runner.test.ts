// 實測（LIVE=1 才跑）：用暫存的 git 倉庫與真的 Codex 常駐服務，跑一次完整的執行流程。
// 測試技能會：執行 git status → 問你要不要繼續 → 你回覆後嘗試 git commit（危險，要你同意）→ 結束。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexRpc } from '../../src/main/codex/rpc';
import { Runner } from '../../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../../src/main/settings';
import { Store } from '../../src/main/store';
import type { VSCode } from '../../src/main/vscode';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

it.runIf(process.env.LIVE)('完整執行流程', { timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-run-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'master-1', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, '.agents/skills/flowpilot-test'), { recursive: true });
  writeFileSync(
    join(seed, '.agents/skills/flowpilot-test/SKILL.md'),
    `---\nname: flowpilot-test\ndescription: FlowPilot 的測試技能\n---\n\n依序做：\n1. 執行 \`git branch --show-current\`。\n2. 回覆「目前分支是 X，要繼續嗎？」然後停下來等使用者回答。\n3. 使用者回答後，執行 \`git clean -n\`（只是預覽，不會刪檔）。不管成功或被拒絕，都回覆「測試完成」並結束。\n`,
  );
  writeFileSync(join(seed, 'package-lock.json'), '{}');
  mkdirSync(join(seed, 'src/environments'), { recursive: true });
  writeFileSync(join(seed, 'src/environments/environment.ts'), "export const apiUrl = 'sit';\n");
  mkdirSync(join(seed, 'node_modules'));
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
  const run = store.createRun([{ key: 'ALL-1', summary: '測試單', status: '進行中', issueType: '子任務', updated: '', url: 'https://example.com/ALL-1', parent: null }]);
  store.confirmPlan(run.id, [{
    ticket: { key: 'ALL-1', summary: '測試單', status: '進行中', issueType: '子任務', updated: '', url: 'https://example.com/ALL-1', parent: null },
    entries: [{ project: 'PlatformWeb', merchants: [1], sourceMerchant: 1, reason: '' }],
    skill: 'flowpilot-test',
    prTitle: 'feat(ALL-1) test',
    reason: '',
  }], {});

  const codex = new CodexRpc('daemon');
  const notes: string[] = [];
  let streamed = '';
  const chatEvents: unknown[] = [];
  const attached: string[] = [];
  const runner = new Runner({
    dataDir: root, writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4200/',
    store,
    settings: () => settings,
    codex,
    vscode: { attach: async (_f: unknown, item: { threadId: string }) => void attached.push(item.threadId) } as unknown as VSCode,
    notify: (title) => notes.push(title),
    onChange: () => {},
    onStream: (_id, text) => void (streamed = text),
    onChat: (_id, event) => void chatEvents.push(event),
    log: (m) => console.log('紀錄', m),
  });
  codex.on((m) => { if (m.method && (m.id !== undefined || m.method === 'item/started')) console.log('Codex：', m.method, m.id ?? '', JSON.stringify(m.params?.item?.command ?? m.params?.command ?? '')); });

  const waitFor = async (pred: () => boolean, label: string, ms = 240_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等待逾時：${label}（目前 ${JSON.stringify(store.listWorkItems()[0])}）`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const item = () => store.listWorkItems()[0];

  runner.startRun(run.id);
  await waitFor(() => item()?.status === 'waiting' || item()?.status === 'review', 'AI 問問題');
  console.log('分支：', git(folder, 'branch', '--show-current').trim(), '｜狀態：', item().status, '｜回覆：', item().lastMessage);
  expect(git(folder, 'branch', '--show-current').trim()).toBe('ban/m1/ALL-1');
  expect(item().status).toBe('waiting');
  expect(streamed.length).toBeGreaterThan(0); // 有收到即時片段
  expect(chatEvents.length).toBeGreaterThan(0); // 聊天畫面有收到即時更新
  const { loadHistory } = await import('../../src/main/chat');
  const history = await loadHistory(codex, item().threadId!);
  console.log('對話紀錄：', history.map((h) => h.kind).join('、'));
  expect(history.some((h) => h.kind === 'user') && history.some((h) => h.kind === 'assistant')).toBe(true);
  expect(attached).toEqual([]); // 不再自動打開 VS Code

  await runner.reply(item().id, '繼續');
  await waitFor(() => item()?.pending?.kind === 'approval' || item()?.status === 'review', '危險指令');
  console.log('等你同意：', JSON.stringify(item().pending), '｜狀態：', item().status, '｜回覆：', item().lastMessage, '｜提交紀錄：', git(folder, 'log', '--oneline').trim());
  expect(item().pending).toMatchObject({ kind: 'approval' });
  await runner.approve(item().id, false);

  await waitFor(() => item()?.status === 'review', 'AI 做完');
  console.log('最後：', item().status, '｜', item().lastMessage, '｜通知：', notes.join('、'));
  expect(git(folder, 'log', '--oneline').trim().split('\n')).toHaveLength(1); // 提交被拒絕，沒有新提交

  // 審查與提交：environment.ts 預設不勾，提交後還原；資料夾變乾淨並讓出來
  writeFileSync(join(folder, 'src/feature.ts'), 'export const x = 1;\n');
  writeFileSync(join(folder, 'src/environments/environment.ts'), "export const apiUrl = 'uat';\n"); // 模擬瀏覽器測試切到 UAT
  const { gitState, stage, commitStaged } = await import('../../src/main/gitpanel');
  const state = await gitState(folder);
  expect(state.unstaged.map((f) => f.path).sort()).toEqual(['src/environments/environment.ts', 'src/feature.ts']);
  await stage(folder, ['src/feature.ts']);
  const sha = await commitStaged(folder, 'feat(ALL-1) test');
  console.log('提交：', sha);
  // environment.ts 還沒處理：不能完成；選擇還原就可以
  await expect(runner.finish(item().id, false)).rejects.toThrow('未提交的修改');
  const id = item().id;
  await runner.finish(id, true);
  expect(store.getWorkItem(id)).toMatchObject({ status: 'committed', lane: 'done' });
  expect(git(folder, 'log', '-1', '--format=%s').trim()).toBe('feat(ALL-1) test');
  expect(git(folder, 'status', '--porcelain').trim()).toBe('');
  expect(readFileSync(join(folder, 'src/environments/environment.ts'), 'utf8')).toContain("'sit'"); // 已還原
  codex.stop();
  store.close();
});
