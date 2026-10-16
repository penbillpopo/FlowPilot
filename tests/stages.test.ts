// 流程階段：開發 → 自動測試（無頭）→ 等你測試 → 修改／重測（有頭）。用假的 Codex，不會啟動真正的 AI。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRpc, RpcMessage } from '../src/main/codex/rpc';
import { i18nWorkFile } from '../src/main/i18n-sheet';
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

  // 可以掛好幾個監聽者（整理交接時 FlowPilot 會另外聽舊對話）
  const listeners: ((m: RpcMessage) => void)[] = [];
  const listener = (m: RpcMessage) => [...listeners].forEach((l) => l(m));
  const requests: { method: string; params: any }[] = [];
  const replies: { id: number; result: unknown }[] = [];
  let turn = 0;
  let loaded = true; // 對話在不在 Codex 的記憶體裡（FlowPilot 重新啟動後，失敗的單不會自動接回）
  const codex = {
    on: (l: (m: RpcMessage) => void) => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)),
    setDisconnectHandler: () => {},
    start: async () => {},
    reply: (id: number, result: unknown) => replies.push({ id, result }),
    request: async (method: string, params: any) => {
      requests.push({ method, params });
      if (method === 'skills/list') return { data: [{ skills: ['frontend-development', 'frontend-playwright-test'].map((name) => ({ name, description: '', path: `/skills/${name}/SKILL.md`, enabled: true })) }] };
      if (method === 'thread/resume') loaded = true;
      if (method === 'turn/start' && !loaded) throw new Error(`thread not found: ${params.threadId}`);
      if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
      if (method === 'thread/start') return { thread: { id: `th-new-${++turn}` } };
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
  const reached: string[] = [];
  const stopped: string[] = [];
  let backendUp = true;
  const runner = new Runner({
    dataDir: join(root, 'data'),
    writeGuard: 'resources/write-guard.cjs', ensureSite: async (name) => (sites.push(name), 'http://localhost:4300/'),
    canReach: async (url) => (reached.push(url), backendUp),
    stopSite: (name) => stopped.push(name),
    store, settings: () => settings, codex, vscode: {} as VSCode,
    notify: () => {}, onChange: () => {}, onStream: () => {}, log: () => {},
  });
  /** AI 這一輪結束；可以帶最後的回覆 */
  const complete = async (lastMessage?: string) => {
    if (lastMessage !== undefined) store.updateWorkItem(item.id, { lastMessage });
    listener({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 80));
  };
  const lastTurn = () => requests.filter((r) => r.method === 'turn/start').at(-1)!.params;
  return { root, folder, store, runner, id: item.id, requests, replies, emit: (m: RpcMessage) => listener(m), sites, reached, stopped, setBackendUp: (v: boolean) => (backendUp = v), complete, lastTurn, unload: () => (loaded = false), get: () => store.getWorkItem(item.id)! };
}

describe('流程階段', () => {
  it('開發完自動接著做無頭測試：用測試技能、無頭瀏覽器、不用確認測試計畫、自動登入', async () => {
    const t = setup();
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'autotest', status: 'running', autotested: true });
    expect(t.sites).toEqual(['PlatformAdmin']);
    const turn = t.lastTurn();
    expect(turn.input[0]).toMatchObject({ type: 'skill', name: 'frontend-playwright-test' });
    const text: string = turn.input[1].text;
    expect(text).toContain('flowpilot_browser_headless');
    expect(text).toContain('不用先給我確認測試計畫');
    expect(text).toContain('http://localhost:4300/');
    expect(text).toContain('SIT');
    expect(text).not.toContain('sit-pass'); // 密碼不寫進指示
    expect(text).toContain('先用終端機指令讀');
    // 寫入防護：可以測新增、儲存，送出的內容記在這張單的請求紀錄檔
    expect(text).toContain('寫入一律會被擋下');
    expect(text).toContain(join(t.root, 'data', '測試請求', `${t.id}.jsonl`));
    expect(readFileSync(join(t.root, 'data', '測試請求', `${t.id}.jsonl`), 'utf8')).toBe('');
    // 登入資料寫在 FlowPilot 的資料夾，不在專案裡
    const file = text.match(/讀 (\S+\.json)（例如 cat）/)![1];
    expect(file.startsWith(join(t.root, 'data'))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ environment: 'SIT', username: 'sit-user', password: 'sit-pass', otp: '123456' });

    expect(text).toContain('測試結果：沒測成（原因）');

    // 自動測試做完 → 等你測試，並記下結果
    await t.complete('……\n測試結果：通過');
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'review', activity: '自動測試通過，等你手動測試', autotestResult: { kind: 'passed' } });
  });

  it('自動測試沒測成（例如登入失敗）：記下原因，不算通過', async () => {
    const t = setup();
    await t.complete(); // 開發完 → 自動測試
    await t.complete('登入回 400，後面都沒測到。\n測試結果：沒測成（登入失敗，帳號或密碼錯誤）');
    expect(t.get()).toMatchObject({ stage: 'manual', autotestResult: { kind: 'failed', reason: '登入失敗，帳號或密碼錯誤' } });
    expect(t.get().activity).toBe('自動測試沒測成：登入失敗，帳號或密碼錯誤');
  });

  it('AI 沒寫結果：看不出來，不當成通過', async () => {
    const t = setup();
    await t.complete();
    await t.complete('目前 Playwright 驗證部分通過。');
    expect(t.get().autotestResult).toEqual({ kind: 'unknown' });
    expect(t.get().activity).toContain('看最後的結果');
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

  it('修改那一輪沒改到任何檔案：不寫「改好了」；有改才寫', async () => {
    const t = setup();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: t.folder });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'init');
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '語系檔放哪？');
    await t.complete('不放在專案內。');
    expect(t.get().activity).toContain('AI 這次沒有改任何檔案');
    await t.runner.reply(t.id, '按鈕改成藍色');
    writeFileSync(join(t.folder, 'a.html'), '<button>');
    await t.complete('改好了');
    expect(t.get().activity).toBe('改好了，等你測試');
  });

  it('AI 做到一半插話：補一句要它答完繼續原本的工作', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '把這些改多語系');
    await t.runner.reply(t.id, '語系檔放哪？');
    const steer = t.requests.filter((r) => r.method === 'turn/steer').at(-1)!.params;
    expect(steer.input[0].text).toContain('語系檔放哪？');
    expect(steer.input[0].text).toContain('繼續剛才還沒做完的工作');
  });

  it('改多語系沒做完：自動叫 AI 繼續；它在問問題就不叫，等你再說到多語系', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '把這些改多語系');
    const work = i18nWorkFile(join(t.root, 'data'), t.id);
    mkdirSync(join(work, '..'), { recursive: true });
    writeFileSync(work, '{"key":"seo_a","en-us":"A"}\n');
    await t.complete('第一批改好了。\n多語系進度：未完成（還剩 Casino）');
    expect(t.lastTurn().input[0].text).toContain('## 繼續改多語系');
    expect(t.lastTurn().input[0].text).not.toContain('驗收表');
    expect(t.get()).toMatchObject({ status: 'running', activity: '多語系：已記下 1 條，自動請 AI 繼續（第 1 次）' });
    const turns = t.requests.filter((r) => r.method === 'turn/start').length;
    await t.complete('Casino 的優惠條款要不要也改？請確認。\n多語系進度：未完成');
    expect(t.requests.filter((r) => r.method === 'turn/start').length).toBe(turns);
    expect(t.get().activity).toContain('多語系還沒做完');
  });

  it('對話用掉五成以上：停下來時請舊對話整理交接、換新對話讀交接，讀完回到原本的狀態', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '按鈕改成藍色');
    t.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th', turnId: 't', tokenUsage: { last: { inputTokens: 140_000 }, modelContextWindow: 258_000 } } });
    writeFileSync(join(t.folder, 'a.html'), '<button>');
    await t.complete('改好了');
    // 先換到新對話，再請舊對話整理
    const newThread = t.get().threadId!;
    expect(newThread).toMatch(/^th-new-/);
    expect(t.get().oldThreads).toEqual(['th']);
    const ask = t.lastTurn();
    expect(ask.threadId).toBe('th');
    expect(ask.input[0].text).toContain('## 整理交接');
    await expect(t.runner.reply(t.id, '再改一次')).rejects.toThrow('換新對話');
    t.emit({ method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage', text: '{"handoff":"按鈕已改成藍色，在 a.html"}' } } });
    t.emit({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 80));
    const warm = t.lastTurn();
    expect(warm.threadId).toBe(newThread);
    expect(warm.input[1].text).toContain('## 換新對話：交接');
    expect(warm.input[1].text).toContain('按鈕已改成藍色，在 a.html');
    expect(warm.input[1].text).toContain('不要提交、不要推送');
    // 舊對話的整理不會被當成這張單的進度
    expect(t.get().activity).toContain('整理重點、換新對話中');
    t.emit({ method: 'turn/completed', params: { threadId: newThread, turn: { status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 80));
    expect(t.get()).toMatchObject({ status: 'review', stage: 'manual' });
    expect(t.get().activity).toContain('已換新對話');
    expect(t.get().activity).toContain('改好了，等你測試');
  });

  it('送出訊息時對話已經太長：先換新對話、讀完交接，再把這句交給新對話', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    t.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th', turnId: 't', tokenUsage: { last: { inputTokens: 150_000 }, modelContextWindow: 258_000 } } });
    const sending = t.runner.reply(t.id, '繼續改多語系');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.lastTurn().input[0].text).toContain('## 整理交接');
    t.emit({ method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage', text: '{"handoff":"多語系做到第 11 段"}' } } });
    t.emit({ method: 'turn/completed', params: { threadId: 'th', turn: { status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 50));
    const newThread = t.get().threadId!;
    expect(t.lastTurn().input[1].text).toContain('多語系做到第 11 段');
    t.emit({ method: 'turn/completed', params: { threadId: newThread, turn: { status: 'completed' } } });
    await sending;
    const sent = t.lastTurn();
    expect(sent.threadId).toBe(newThread);
    expect(sent.input[0].text).toContain('繼續改多語系');
    expect(t.get()).toMatchObject({ status: 'running', stage: 'fix' });
  });

  it('對話還短、或停在等你同意指令：不換', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '按鈕改成藍色');
    t.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th', turnId: 't', tokenUsage: { last: { inputTokens: 50_000 }, modelContextWindow: 258_000 } } });
    await t.complete('改好了');
    expect(t.get().threadId).toBe('th');
    expect(t.requests.some((r) => r.method === 'thread/start')).toBe(false);
  });

  it('多語系進度：AI 在做就是「正在改」，停下來就是「還沒做完」，沒在改就沒有', async () => {
    const t = setup();
    const progress = () => t.runner.board().items.find((i) => i.id === t.id)!.i18n;
    expect(progress()).toBeNull();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '把這些改多語系');
    const work = i18nWorkFile(join(t.root, 'data'), t.id);
    mkdirSync(join(work, '..'), { recursive: true });
    writeFileSync(work, '{"key":"seo_a","en-us":"A"}\n{"key":"seo_b","en-us":"B"}\n');
    expect(progress()).toMatchObject({ phase: 'working', count: 2, at: expect.any(Number) });
    await t.complete('Casino 要不要改？請確認。\n多語系進度：未完成');
    expect(progress()).toMatchObject({ phase: 'paused', count: 2 });
  });

  it('開瀏覽器測給我看：有頭、先確認測試計畫；帳號照帳號檔裡這個環境的', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    t.runner.switchEnvironment(t.id, 'uat');
    expect(readFileSync(join(t.folder, 'src/environments/environment.ts'), 'utf8')).toContain("  // apiUrl: 'http://sit/api',");
    expect(t.runner.testState(t.id)).toMatchObject({ environment: 'uat', account: { username: 'uat-user' } });

    await t.runner.retest(t.id);
    expect(t.get()).toMatchObject({ stage: 'retest', status: 'running' });
    const text: string = t.lastTurn().input[1].text;
    expect(text).toContain('只能用 flowpilot_browser 這個瀏覽器工具');
    expect(text).toContain('等我確認後才開始');
    expect(text).toContain('UAT');
    const file = text.match(/讀 (\S+\.json)（例如 cat）/)![1];
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ environment: 'UAT', username: 'uat-user', password: 'uat-pass' });
    // 畫面拿不到密碼
    expect(JSON.stringify(t.runner.testState(t.id))).not.toContain('uat-pass');

    await t.complete('測試結果：部分通過（儲存的 payload 要你手動測）');
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'review', activity: '重測部分通過：儲存的 payload 要你手動測，等你手動測試' });
    expect(t.get().autotestResult).toBeNull(); // 重測不改自動測試那一格
    // AI 執行中不能重測
    t.store.updateWorkItem(t.id, { status: 'running' });
    await expect(t.runner.retest(t.id)).rejects.toThrow('AI 還在執行');
  });

  it('沒有帳號時不開始測試，停下來請你補帳號檔', async () => {
    const t = setup({ account: false });
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'waiting', autotested: false, autotestResult: { kind: 'failed' } });
    expect(t.get().activity).toContain('PlatformAdmin.playwright.json 補上');
    expect(t.sites).toEqual([]);
  });

  it('有帳號但還沒填密碼：畫面顯示帳號並提醒補密碼，不開始測試', async () => {
    const t = setup({ account: false });
    writeFileSync(join(t.root, 'configs', 'PlatformAdmin.playwright.json'), JSON.stringify({ environments: [{ environment: 'SIT', username: 'ban@intellianalyze.com', passwordSource: '' }] }));
    expect(t.runner.testState(t.id).account).toEqual({ username: 'ban@intellianalyze.com', hasPassword: false });
    await t.complete();
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'waiting' });
    expect(t.get().activity).toContain('還沒有密碼');
    expect(t.sites).toEqual([]);
  });

  it('連不到後端（沒開 VPN）就不開始測試，直接提醒', async () => {
    const t = setup();
    t.setBackendUp(false);
    await t.complete();
    expect(t.reached).toEqual(['http://sit/api']);
    expect(t.get()).toMatchObject({ stage: 'manual', status: 'waiting' });
    expect(t.get().activity).toContain('VPN 有開嗎');
    expect(t.sites).toEqual([]);
  });

  it('自動測試沒測成，處理好之後可以重跑（無頭），AI 執行中不行', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review', autotestResult: { kind: 'failed', reason: '登入失敗' } });
    await t.runner.rerunAutotest(t.id);
    expect(t.get()).toMatchObject({ stage: 'autotest', status: 'running' });
    expect(t.lastTurn().input[1].text).toContain('flowpilot_browser_headless');
    await expect(t.runner.rerunAutotest(t.id)).rejects.toThrow('AI 還在執行');
  });

  it('更新需求不算要求修改：做完不會寫「改好了」', async () => {
    const t = setup();
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.reply(t.id, '## 更新需求…', [], { asFix: false, activity: '請 AI 比對需求變更' });
    expect(t.get()).toMatchObject({ stage: 'manual', activity: '請 AI 比對需求變更' });
    await t.complete('這個需求沒有變更');
    expect(t.get().activity).toBe('需求比對完了，等你測試');
  });

  it('完成這張單時停掉本機網站', async () => {
    const t = setup();
    execFileSync('git', ['init', '-q'], { cwd: t.folder });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: t.folder });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: t.folder });
    t.store.updateWorkItem(t.id, { stage: 'manual', status: 'review' });
    await t.runner.finish(t.id, true);
    expect(t.stopped).toEqual(['PlatformAdmin']);
    expect(t.get().status).toBe('committed');
  });

  it('檢查計畫要自我審查：開發完先審查，審查完才自動測試', async () => {
    const t = setup();
    t.store.saveReview({ ticketKey: 'ALL-1', entries: [], prTitle: '', reason: '', summary: [], resources: [], level: '一般', codeChecked: true, issues: [], discussion: [], reviewedAt: '',
      checks: { figma: { need: false, reason: '' }, codeReview: { need: true, reason: '改到表單驗證' }, designCompare: { need: false, reason: '' } } }, null);
    await t.complete(); // 開發完
    expect(t.get()).toMatchObject({ stage: 'selfcheck', status: 'running' });
    expect(t.lastTurn().input[0].text).toContain('## 自我審查');
    expect(t.sites).toEqual([]);
    await t.complete(); // 審查完
    expect(t.get().stage).toBe('autotest');
    expect(t.sites).toEqual(['PlatformAdmin']);
  });

  it('檢查計畫要比對設計稿、單上有 Figma：測試指示加上比對要求；不需要就不加', async () => {
    const t = setup();
    const figma = { kind: 'figma' as const, title: 'Banner', url: 'https://www.figma.com/design/abc/Banner?node-id=1-2', from: 'ALL-1' };
    const base = { ticketKey: 'ALL-1', entries: [], prTitle: '', reason: '', summary: [], resources: [figma], level: '一般' as const, codeChecked: true, issues: [], discussion: [], reviewedAt: '' };
    t.store.saveReview({ ...base, checks: { figma: { need: false, reason: '' }, codeReview: { need: false, reason: '' }, designCompare: { need: true, reason: '新畫面' } } }, null);
    await t.complete();
    expect(t.lastTurn().input[1].text).toContain('比對設計稿：');
    expect(t.lastTurn().input[1].text).toContain(figma.url);

    const u = setup();
    u.store.saveReview({ ...base, checks: { figma: { need: false, reason: '' }, codeReview: { need: false, reason: '' }, designCompare: { need: false, reason: '' } } }, null);
    await u.complete();
    expect(u.lastTurn().input[1].text).not.toContain('比對設計稿：');
  });

  it('測試做完存下報告；指示裡要求逐條對照預期結果並附報告；可以勾選手動項目', async () => {
    const t = setup();
    t.store.saveReview({ ticketKey: 'ALL-1', entries: [], prTitle: '', reason: '', summary: [], resources: [], level: '小', codeChecked: false, issues: [], discussion: [], reviewedAt: '', acceptance: ['預設選 All', '數值必填'] }, null);
    await t.complete();
    const text: string = t.lastTurn().input[1].text;
    expect(text).toContain('1. 預設選 All');
    expect(text).toContain('```flowpilot-test');
    await t.complete('```flowpilot-test\n{"acceptance":[{"no":1,"text":"預設選 All","result":"通過","note":""}],"manual":["存檔後列表多一筆"]}\n```\n測試結果：通過');
    expect(t.get().testReport?.acceptance).toMatchObject([{ no: 1, text: '預設選 All', result: '通過', note: '' }]);
    expect(t.get().testReport?.manual).toEqual([{ text: '存檔後列表多一筆', done: false }]);
    t.runner.setManualDone(t.id, 0, true);
    expect(t.get().testReport?.manual[0].done).toBe(true);
    t.runner.setChecked(t.id, 1, true);
    expect(t.get().testReport?.acceptance[0].checked).toBe(true);

    // 等你測試時要求修改：訊息後面附上請 AI 更新驗收表的說明；改完附的新驗收表會存下來
    await t.runner.reply(t.id, '按鈕顏色改成藍色');
    const fix: string = t.lastTurn().input[0].text;
    expect(fix.startsWith('按鈕顏色改成藍色\n\n［FlowPilot 附註］')).toBe(true);
    expect(t.get().stage).toBe('fix');
    await t.complete('改好了\n```flowpilot-test\n{"acceptance":[{"no":1,"text":"預設選 All","result":"沒測","change":"按鈕改藍色","needYou":true}]}\n```');
    expect(t.get().testReport?.acceptance[0]).toMatchObject({ change: '按鈕改藍色', changed: true, checked: false });
  });

  it('測試做到一半接著做（重試、補充指示）：先確認本機網站有在跑', async () => {
    const t = setup();
    await t.complete('做完了'); // 進自動測試
    const before = t.sites.length;
    t.store.updateWorkItem(t.id, { status: 'failed' });
    await t.runner.reply(t.id, '請從剛才中斷的地方繼續。');
    expect(t.sites.length).toBe(before + 1);
  });

  it('對話不在 Codex 的記憶體裡（FlowPilot 重新啟動過）：先接回再開始這一輪，不會報 thread not found', async () => {
    const t = setup();
    await t.complete('做完了');
    await t.complete('測試結果：通過');
    t.unload();
    await t.runner.reply(t.id, '請從剛才中斷的地方繼續。');
    const methods = t.requests.map((r) => r.method);
    expect(methods.slice(-3)).toEqual(['turn/start', 'thread/resume', 'turn/start']);
    expect(t.get().status).toBe('running');
  });

  it('AI 開的子 AI 要求同意：認得是這張單的，照同一套規則處理，不會互等卡住', async () => {
    const t = setup();
    // 主對話裡出現開子 AI 的事件（帶著子 AI 的對話編號）
    t.emit({ method: 'item/started', params: { threadId: 'th', item: { type: 'subAgentActivity', kind: 'started', agentThreadId: '01a12bdf-f9b1-7f30-acaa-eb7f28cbf76c' } } });
    // 子 AI 要執行安全的指令：自動同意
    t.emit({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: '01a12bdf-f9b1-7f30-acaa-eb7f28cbf76c', command: 'ls -la' } });
    await new Promise((r) => setTimeout(r, 80));
    expect(t.replies).toContainEqual({ id: 77, result: { decision: 'accept' } });
    // 子 AI 要推送：轉給你
    t.emit({ id: 78, method: 'item/commandExecution/requestApproval', params: { threadId: '01a12bdf-f9b1-7f30-acaa-eb7f28cbf76c', command: 'git push origin x' } });
    await new Promise((r) => setTimeout(r, 80));
    expect(t.get().pending).toMatchObject({ kind: 'approval', requestId: 78 });
    // 子 AI 做完不算這張單的進度
    t.store.updateWorkItem(t.id, { status: 'running', pending: null });
    t.emit({ method: 'turn/completed', params: { threadId: '01a12bdf-f9b1-7f30-acaa-eb7f28cbf76c', turn: { status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 80));
    expect(t.get()).toMatchObject({ status: 'running', stage: 'develop' });
  });

  it('審閱紀錄跟著工作台走：移除或完成時刪掉；同一張單還有別的列在工作台上就先留著', async () => {
    const t = setup();
    const review = { ticketKey: 'ALL-1', entries: [], prTitle: '', reason: '', summary: [], resources: [], level: '小' as const, codeChecked: false, issues: [], discussion: [], reviewedAt: '' };
    t.store.saveReview(review, null);
    // 同一張單在另一個專案還有一列
    const run = t.store.createRun([{ key: 'ALL-1', summary: '', status: '', issueType: '', updated: '', url: '', parent: null }]);
    const [other] = t.store.createWorkItems([{
      runId: run.id, ticketKey: 'ALL-1', ticketSummary: '', mainKey: 'ALL-1', mainUrl: '', project: 'PlatformWeb', merchant: 1,
      targetMerchants: [], branch: 'ban/m1/ALL-1', baseBranch: 'master-1', skill: 'x', prTitle: 'x', preferredFolder: null,
    }]);
    t.store.updateWorkItem(t.id, { status: 'review' });
    await t.runner.remove(t.id);
    expect(t.store.getReview('ALL-1')).not.toBeNull(); // 另一列還在
    await t.runner.remove(other.id);
    expect(t.store.getReview('ALL-1')).toBeNull();
    expect(t.store.hasActiveTicket('ALL-1')).toBe(false);
  });

  it('打開時清掉不在工作台上的單的審閱紀錄', () => {
    const t = setup(); // ALL-1 在工作台上
    const base = { entries: [], prTitle: '', reason: '', summary: [], resources: [], level: '小' as const, codeChecked: false, issues: [], discussion: [], reviewedAt: '' };
    t.store.saveReview({ ...base, ticketKey: 'ALL-1' }, null);
    t.store.saveReview({ ...base, ticketKey: 'ALL-9' }, null);
    expect(t.store.purgeOrphanReviews()).toBe(1);
    expect(t.store.getReview('ALL-1')).not.toBeNull();
    expect(t.store.getReview('ALL-9')).toBeNull();
  });
});

describe('共用瀏覽器的說明', () => {
  it('每段對話這次啟動後第一次收到你的話，附上一次（對話裡看不到），之後不再附', async () => {
    const { toEntry } = await import('../src/main/chat');
    const t = setup();
    t.store.updateWorkItem(t.id, { status: 'review', stage: 'manual' });
    await t.runner.reply(t.id, '看一下我開的畫面');
    const first: string = t.lastTurn().input[0].text;
    expect(first).toContain('flowpilot_shared_browser');
    expect(toEntry({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: first }] })!.text).toBe('看一下我開的畫面');
    await t.complete('好');
    await t.runner.reply(t.id, '再看一次');
    expect(t.lastTurn().input[0].text).not.toContain('flowpilot_shared_browser');
  });
});
