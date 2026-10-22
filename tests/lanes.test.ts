// 工作項目的移除與暫停
import { describe, expect, it } from 'vitest';
import type { CodexRpc } from '../src/main/codex/rpc';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { VSCode } from '../src/main/vscode';

function setup() {
  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const make = (key: string) =>
    store.createWorkItems([{
      runId: run.id, ticketKey: key, ticketSummary: '', mainKey: key, mainUrl: '', project: 'PlatformAdmin', merchant: null,
      targetMerchants: [], branch: `ban/${key}`, baseBranch: 'version/0.0.1', skill: 'x', prTitle: `feat(${key}) x`, preferredFolder: null,
    }])[0];
  const fakeCodex = { on: () => () => {}, setDisconnectHandler: () => {} } as unknown as CodexRpc;
  const runner = new Runner({
    dataDir: '/nonexistent/flowpilot', writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4200/',
    store, settings: () => settings, codex: fakeCodex, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  return { store, runner, make };
}

describe('移除', () => {
  it('排隊中、等你測試、已完成的單都可以移除；AI 執行中、準備中的不行（要先中斷）', async () => {
    const { store, runner, make } = setup();
    const a = make('ALL-1');
    const b = make('ALL-2');
    const c = make('ALL-3');
    const d = make('ALL-4');
    store.updateWorkItem(a.id, { lane: 'development', status: 'running', folder: 'PlatformAdmin', threadId: 't1' });
    store.updateWorkItem(b.id, { lane: 'development', status: 'preparing', folder: 'PlatformWeb' });
    store.updateWorkItem(d.id, { lane: 'done', status: 'committed' });
    await expect(runner.remove(a.id)).rejects.toThrow('AI 還在執行');
    await expect(runner.remove(b.id)).rejects.toThrow('AI 還在執行');
    await runner.remove(c.id);
    await runner.remove(d.id);
    for (const id of [c.id, d.id]) expect(store.getWorkItem(id)).toMatchObject({ status: 'removed', lane: 'done' });
    // 已完成的單在移除前還留在工作台上
    expect(store.listWorkItems().map((i) => i.ticketKey)).toEqual(['ALL-1', 'ALL-2']);
  });
});

describe('單列表的標記', () => {
  it('還在做的是進行中（含失敗、停止）、都按過完成的是已完成、移除後不在工作台上', () => {
    const { store, make } = setup();
    const a = make('ALL-1');
    const b = make('ALL-2');
    const c = make('ALL-3');
    store.updateWorkItem(a.id, { status: 'failed' });
    store.updateWorkItem(b.id, { status: 'committed' });
    store.updateWorkItem(c.id, { status: 'removed' });
    expect(store.ticketWorkState('ALL-1')).toBe('active');
    expect(store.ticketWorkState('ALL-2')).toBe('done');
    expect(store.ticketWorkState('ALL-3')).toBeNull();
    expect(store.ticketWorkState('ALL-9')).toBeNull();
    // 再次開發時要收起來的舊卡片：只有已完成的
    expect(store.doneWorkItemIds('ALL-2')).toEqual([b.id]);
    expect(store.doneWorkItemIds('ALL-1')).toEqual([]);
    expect(store.doneWorkItemIds('ALL-3')).toEqual([]);
  });
});

describe('暫停', () => {
  it('暫停時有排隊的單也不會開始', async () => {
    const settings = parseSettings(DEFAULT_SETTINGS_YAML);
    const store = new Store(':memory:');
    const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
    store.createWorkItems([{
      runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformAdmin', merchant: null,
      targetMerchants: [], branch: 'ban/ALL-1', baseBranch: 'version/0.0.1', skill: 'x', prTitle: 'feat(ALL-1) x', preferredFolder: null,
    }]);
    const runner = new Runner({
    dataDir: '/nonexistent/flowpilot', writeGuard: 'resources/write-guard.cjs', ensureSite: async () => 'http://localhost:4200/',
      store, settings: () => settings, codex: { on: () => () => {}, setDisconnectHandler: () => {} } as unknown as CodexRpc, vscode: {} as VSCode,
      notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {}, paused: true,
    });
    await runner.schedule();
    await runner.resubscribe();
    expect(store.listWorkItems()[0]).toMatchObject({ status: 'queued', lane: 'waiting', folder: null });
  });
});
