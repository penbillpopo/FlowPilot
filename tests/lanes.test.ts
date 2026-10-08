// 一次只跟一張單對話：換下一張時檢查開發佇列上限
import { describe, expect, it } from 'vitest';
import type { CodexRpc } from '../src/main/codex/rpc';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { VSCode } from '../src/main/vscode';

function setup(maxInDevelopment: number) {
  const settings = { ...parseSettings(DEFAULT_SETTINGS_YAML), maxInDevelopment };
  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const make = (key: string) =>
    store.createWorkItems([{
      runId: run.id, ticketKey: key, ticketSummary: '', mainKey: key, mainUrl: '', project: 'PlatformAdmin', merchant: null,
      targetMerchants: [], branch: `ban/${key}`, baseBranch: 'version/0.0.1', skill: 'x', prTitle: `feat(${key}) x`, preferredFolder: null,
    }])[0];
  const fakeCodex = { on: () => () => {}, setDisconnectHandler: () => {} } as unknown as CodexRpc;
  const runner = new Runner({
    store, settings: () => settings, codex: fakeCodex, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  return { store, runner, make };
}

describe('換下一張', () => {
  it('開發佇列滿了就不能換；有一張提交後就可以', async () => {
    const { store, runner, make } = setup(1);
    const a = make('ALL-1');
    const b = make('ALL-2');
    store.updateWorkItem(a.id, { lane: 'development', status: 'running', folder: 'PlatformAdmin' });
    store.updateWorkItem(b.id, { lane: 'conversation', status: 'waiting', folder: 'PlatformWeb' });
    await expect(runner.handOff(b.id)).rejects.toThrow('開發佇列已滿（1／1）');
    expect(runner.board().development).toEqual({ max: 1, count: 1 });

    store.updateWorkItem(a.id, { lane: 'done', status: 'committed' });
    await runner.handOff(b.id);
    expect(store.getWorkItem(b.id)!.lane).toBe('development');
  });

  it('只有對話中的單可以換下一張', async () => {
    const { store, runner, make } = setup(3);
    const a = make('ALL-1');
    store.updateWorkItem(a.id, { lane: 'development', status: 'running' });
    await expect(runner.handOff(a.id)).rejects.toThrow('只有對話中的單');
  });
});

describe('移除', () => {
  it('執行中、準備中、排隊中的單都可以移除，移除後讓下一張接上', async () => {
    const { store, runner, make } = setup(3);
    const a = make('ALL-1');
    const b = make('ALL-2');
    const c = make('ALL-3');
    store.updateWorkItem(a.id, { lane: 'development', status: 'running', folder: 'PlatformAdmin', threadId: 't1' });
    store.updateWorkItem(b.id, { lane: 'conversation', status: 'preparing', folder: 'PlatformWeb' });
    await runner.remove(a.id);
    await runner.remove(b.id);
    await runner.remove(c.id);
    for (const id of [a.id, b.id, c.id]) expect(store.getWorkItem(id)).toMatchObject({ status: 'removed', lane: 'done' });
    expect(store.listWorkItems()).toEqual([]);
  });
});
