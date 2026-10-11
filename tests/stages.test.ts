// 流程階段：開發 → 自動測試（無頭）→ 等你測試 → 修改／重測（有頭）。用假的 Codex，不會啟動真正的 AI。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc, RpcMessage } from '../src/main/codex/rpc';
import { Runner } from '../src/main/runner/runner';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import { Store } from '../src/main/store';
import type { VSCode } from '../src/main/vscode';

const ENV = `export const environment = {
  /** SIT */
  apiUrl: 'http://sit/api',
  /** UAT */
  // apiUrl: 'http://uat/api',
};
`;

function setup({ account = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-stages-'));
  const folder = join(root, 'PlatformAdmin');
  mkdirSync(join(folder, 'src/environments'), { recursive: true });
  writeFileSync(join(folder, 'src/environments/environment.ts'), ENV);
  const configs = join(root, 'configs');
  mkdirSync(configs);
  if (account) {
    writeFileSync(join(configs, 'PlatformAdmin.playwright.json'), JSON.stringify({ environments: [
      { environment: 'SIT', username: 'sit-user', passwordSource: 'sit-pass', otp: '123456' },
      { environment: 'UAT', username: 'uat-user', passwordSource: 'uat-pass' },
    ] }));
  }
  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  settings.folders = [{ name: 'PlatformAdmin', path: folder, project: 'PlatformAdmin', port: 4300 }];
  settings.testConfigDir = configs;

  let listener: (m: RpcMessage) => void = () => {};
  const requests: { method: string; params: any }[] = [];
  let turn = 0;
  const codex = {
    on: (l: (m: RpcMessage) => void) => ((listener = l), () => {}),
    setDisconnectHandler: () => {},
    start: async () => {},
    reply: () => {},
    request: async (method: string, params: any) => {
      requests.push({ method, params });
      if (method === 'skills/list') return { data: [{ skills: ['frontend-development', 'frontend-playwright-test'].map((name) => ({ name, description: '', path: `/skills/${name}/SKILL.md`, enabled: true })) }] };
      if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
      return {};
    },
  } as unknown as CodexRpc;

  const store = new Store(':memory:');
  const run = store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
  const item = store.createWorkItems([{
    runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformAdmin', merchant: null,
    targetMerchants: [], branch: 'ban/ALL-1', baseBranch: 'version/0.0.1', skill: 'frontend-development', prTitle: 'feat(ALL-1) x', preferredFolder: null,
  }])[0];
  store.updateWorkItem(item.id, { lane: 'development', status: 'running', stage: 'develop', folder: 'PlatformAdmin', threadId: 'th' });
  const sites: string[] = [];
  const runner = new Runner({
    dataDir: join(root, 'data'),
    ensureSite: async (name) => (sites.push(name), 'http://localhost:4300/'),
    store, settings: () => settings, codex, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  const complete = async () => {
    listener({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 20));
  };
  const lastTurn = () => requests.filter((r) => r.method === 'turn/start').at(-1)!.params;
  return { root, folder, store, runner, id: item.id, requests, sites, complete, lastTurn, get: () => store.getWorkItem(item.id)! };
}

describe('流程階段', () => {
  it('開發完自動接著做無頭測試：用測試技能、無頭瀏覽器、不用確認測試計畫、自動登入', async () => {
    const t = setup();
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'autotest', status: 'running' });
    expect(t.sites).toEqual(['PlatformAdmin']);
    const turn = t.lastTurn();
    expect(turn.input[0]).toMatchObject({ type: 'skill', name: 'frontend-playwright-test' });
    const text: string = turn.input[1].text;
    expect(text).toContain('flowpilot_browser_headless');
    expect(text).toContain('不用先給我確認測試計畫');
    expect(text).toContain('http://localhost:4300/');
    expect(text).toContain('SIT');
    expect(text).not.toContain('sit-pass'); // 密碼不寫進指示
    // 登入資料寫在 FlowPilot 的資料夾，不在專案裡
    const file = text.match(/讀 (\S+\.json) 裡的帳號密碼/)![1];
    expect(file.startsWith(join(t.root, 'data'))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ environment: 'SIT', username: 'sit-user', password: 'sit-pass', otp: '123456' });

    // 自動測試做完 → 等你測試
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'review', activity: '自動測試完成，等你手動測試' });
  });

  it('等你測試時要求修改 → 修改中；改完回到等你測試，不會再自動測試', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '按鈕改成藍色');
    expect(t.get().stage).toBe('fix');
    const turns = t.requests.filter((r) => r.method === 'turn/start').length;
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'review', activity: '改好了，等你測試' });
    expect(t.requests.filter((r) => r.method === 'turn/start').length).toBe(turns);
  });

  it('開瀏覽器測給我看：有頭、先確認測試計畫；指定的帳號優先，只限這張單', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    t.runner.switchEnvironment(t.id, 'uat');
    expect(readFileSync(join(t.folder, 'src/environments/environment.ts'), 'utf8')).toContain("  // apiUrl: 'http://sit/api',");
    expect(t.runner.testState(t.id)).toEqual({ environment: 'uat', account: { username: 'uat-user', source: '帳號檔' }, override: null });
    expect(t.runner.setTestAccount(t.id, { username: ' me ', password: 'secret' })).toMatchObject({ account: { username: 'me', source: '這張單指定' }, override: 'me' });

    await t.runner.retest(t.id);
    expect(t.get()).toMatchObject({ stage: 'retest', status: 'running' });
    const text: string = t.lastTurn().input[1].text;
    expect(text).toContain('只能用 flowpilot_browser 這個瀏覽器工具');
    expect(text).toContain('等我確認後才開始');
    expect(text).toContain('UAT');
    const file = text.match(/讀 (\S+\.json) 裡的帳號密碼/)![1];
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ environment: 'UAT', username: 'me', password: 'secret' });
    // 畫面拿不到密碼
    expect(JSON.stringify(t.runner.board())).not.toContain('secret');

    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'review', activity: '重測完成，等你確認' });
    // AI 執行中不能重測
    t.store.updateWorkItem(t.id, { status: 'running' });
    await expect(t.runner.retest(t.id)).rejects.toThrow('AI 還在執行');
  });

  it('沒有帳號時不開始測試，停下來請你指定', async () => {
    const t = setup({ account: false });
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'waiting' });
    expect(t.get().activity).toContain('請在右邊「測試」指定這張單要用的帳號');
    expect(t.sites).toEqual([]);
  });
});
