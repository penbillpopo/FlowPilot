// 分析報告（自己理解用）：這張單要做什麼、改動前 vs 改動後（截圖）、重點、驗收結果、技術附錄，存成桌面的 PDF。
// 流程：
// 1. 截「改動前」：在 FlowPilot 的暫存資料夾開一個 git worktree（分支開出來的那個基底提交），借用專案的 node_modules，
//    暫時停掉這張單的本機網站、在同一個連接埠啟動舊版網站（有些專案的連接埠寫死，只能輪流用），請 AI 用測試瀏覽器登入、截圖。
// 2. 截「改動後」：關掉舊版網站、重新啟動這張單的網站，同樣的頁面再截一次。
// 3. 請 AI 照需求、驗收表、改動檔案寫報告內容（唯讀，不改程式）。
// 4. 排成網頁、用 Electron 轉成 PDF。
// 只在測試環境截圖；不改程式、不推送、不發到 Jira。截不到的就寫原因，報告照樣產生。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { getLang, t, zhOnly } from '../shared/i18n';
import type { AcceptanceItem, Review, WorkItem } from '../shared/types';
import { needsYou } from '../shared/acceptance';
import type { CodexRpc } from './codex/rpc';
import { runStructured } from './codex/structured';
import { apiHosts, ENVIRONMENT_FILE, readApiUrl, readEnvironment } from './environment';
import type { FolderTerminals } from './folderterminals';
import { reviewBrief } from './planner/review';
import { resolveAccount, writeAccountFile } from './testaccounts';

export interface ReportDeps {
  codex: CodexRpc;
  dataDir: string;
  folderTerminals: FolderTerminals;
  /** 這張單的資料夾（名稱、路徑、連接埠、啟動指令） */
  folder: { name: string; path: string; port: number; command: string };
  testConfigDir: string;
  review: Review | null;
  /** 測試瀏覽器（無頭、有寫入防護）的工具設定 */
  browser: (hosts: string[]) => { name: string; config: unknown };
  log(message: string): void;
  progress(text: string): void;
}

interface Capture {
  key: string;
  title: string;
  shot: string;
  note: string;
}

const run = (cwd: string, args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) =>
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout: String(stdout ?? '') })),
  );

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function waitFree(url: string) {
  for (let i = 0; i < 40 && (await reachable(url)); i++) await new Promise((r) => setTimeout(r, 1000));
}

const SHOT = /^[\w.\-]+\.png$/i;

/** 請 AI 用測試瀏覽器登入、照清單截圖；回傳截到的（檔名在瀏覽器測試紀錄資料夾） */
async function capture(deps: ReportDeps, item: WorkItem, url: string, prefix: string, targets: { key: string; title: string; how: string }[], hosts: string[]): Promise<Capture[]> {
  const env = readEnvironment(deps.folder.path);
  const account = env === 'sit' || env === 'uat' ? resolveAccount(deps.testConfigDir, item.project, item.merchant, env) : null;
  const accountFile = account && env !== 'mixed' && env ? writeAccountFile(join(deps.dataDir, '測試帳號'), item.id, { project: item.project, merchant: item.merchant, environment: env, url, account }) : null;
  const tool = deps.browser(hosts);
  const { result } = await runStructured<{ captures: Capture[] }>(deps.codex, {
    cwd: deps.dataDir,
    timeoutMs: 600_000,
    keepLanguage: true,
    config: { mcp_servers: { [tool.name]: tool.config } },
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['captures'],
      properties: {
        captures: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'title', 'shot', 'note'],
            properties: { key: { type: 'string' }, title: { type: 'string' }, shot: { type: 'string' }, note: { type: 'string' } },
          },
        },
      },
    },
    prompt: zhOnly(
      [
        `只做一件事：用 ${tool.name} 這個瀏覽器工具打開 ${url}，照下面的清單把畫面截下來，給分析報告用。`,
        accountFile ? `要登入時，帳號密碼用終端機讀 ${accountFile}（例如 cat），要 OTP 就填檔案裡的 otp。不要把密碼寫進回覆。` : '這次沒有測試帳號，只截不用登入的頁面。',
        `每一項用 browser_take_screenshot 存一張圖，filename 用 ${prefix}-<key>.png；截圖前先等畫面載入完。`,
        '只看不改：不要按會存檔、送出、刪除的按鈕。截不到（頁面打不開、要特定資料才看得到）就把 shot 留空，note 寫原因。',
        '回傳每一項：key 照清單、title 一句話寫截的是什麼畫面、shot 只填檔名、note 一句話寫畫面上看到的重點。',
        '',
        ...targets.map((x) => `- key ${x.key}：${x.title}（${x.how}）`),
      ].join('\n'),
    ),
  });
  return (result.captures ?? []).map((c) => ({ ...c, shot: SHOT.test(c.shot) && existsSync(join(deps.dataDir, '瀏覽器測試紀錄', c.shot)) ? c.shot : '' }));
}

/** 用 worktree 跑「改動前」的網站：開分支前的那個提交，借用專案的 node_modules 和目前的環境設定 */
async function withBeforeSite<T>(deps: ReportDeps, item: WorkItem, use: (url: string) => Promise<T>): Promise<T | null> {
  const repo = deps.folder.path;
  const base = (await run(repo, ['merge-base', 'HEAD', `origin/${item.baseBranch}`])).stdout.trim();
  if (!base) return null;
  const dir = join(deps.dataDir, '分析報告', 'before', String(item.id));
  rmSync(dir, { recursive: true, force: true });
  await run(repo, ['worktree', 'prune']);
  const added = await run(repo, ['worktree', 'add', '--detach', dir, base]);
  if (added.code !== 0) return null;
  const session = `report-before-${item.id}`;
  const url = `http://localhost:${deps.folder.port}/`;
  try {
    if (existsSync(join(repo, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
    // 環境照這張單目前選的 SIT／UAT
    if (existsSync(join(repo, ENVIRONMENT_FILE))) copyFileSync(join(repo, ENVIRONMENT_FILE), join(dir, ENVIRONMENT_FILE));
    deps.folderTerminals.interrupt(deps.folder.name);
    await waitFree(url);
    deps.progress(t('啟動改動前的網站（第一次編譯要等一下）'));
    await deps.folderTerminals.ensureSite(session, dir, deps.folder.command, deps.folder.port);
    return await use(url);
  } catch (error) {
    deps.log(`${item.ticketKey}：改動前的畫面截不到：${(error as Error).message}`);
    return null;
  } finally {
    deps.folderTerminals.close(session);
    await waitFree(url);
    await run(repo, ['worktree', 'remove', '--force', dir]);
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function img(dataDir: string, shot: string | undefined): string {
  if (!shot || !SHOT.test(shot)) return '';
  const file = join(dataDir, '瀏覽器測試紀錄', shot);
  if (!existsSync(file)) return '';
  return `<img src="data:image/png;base64,${readFileSync(file).toString('base64')}">`;
}

interface ReportText {
  oneLiner: string;
  background: string;
  scope: string;
  judged: string[];
  changes: { title: string; before: string; after: string; captureKey: string }[];
  highlights: string[];
  files: { file: string; purpose: string }[];
}

/** 產生分析報告，存到桌面，回傳檔案路徑 */
export async function generateReport(deps: ReportDeps, item: WorkItem): Promise<string> {
  const report = item.testReport;
  const cwd = deps.folder.path;
  const hosts = apiHosts(cwd);
  const apiUrl = readApiUrl(cwd);
  const canReach = apiUrl ? await reachable(apiUrl) : true;
  // 要截的畫面：每一條預期結果（有步驟就照步驟）
  const targets = (report?.acceptance ?? []).map((a) => ({
    key: `ac${a.no}`,
    title: a.text,
    how: [a.page && `頁面 ${a.page}`, a.open, a.act, a.expect && `應該看到：${a.expect}`].filter(Boolean).join('；') || a.howToTest || '',
  }));
  const prefix = `report-${item.id}`;

  let before: Capture[] = [];
  let after: Capture[] = [];
  let shotNote = '';
  if (!targets.length) shotNote = t('驗收表沒有項目，沒有截圖');
  else if (!canReach) shotNote = t('連不到測試環境的後端（VPN 有開嗎？），沒有截圖');
  else {
    deps.progress(t('截改動前的畫面'));
    before = (await withBeforeSite(deps, item, (url) => capture(deps, item, url, `${prefix}-before`, targets, hosts))) ?? [];
    deps.progress(t('截改動後的畫面'));
    const url = await deps.folderTerminals.ensureSite(deps.folder.name, cwd, deps.folder.command, deps.folder.port);
    after = await capture(deps, item, url, `${prefix}-after`, targets, hosts).catch((error) => {
      deps.log(`${item.ticketKey}：改動後的畫面截不到：${(error as Error).message}`);
      return [];
    });
    if (!before.some((c) => c.shot)) shotNote = t('改動前的畫面沒截到（舊版網站開不起來或頁面打不開），只放改動後');
  }

  deps.progress(t('AI 整理報告內容'));
  const diffStat = (await run(cwd, ['diff', '--stat', `origin/${item.baseBranch}...HEAD`])).stdout.slice(0, 4000);
  const lang = getLang() === 'en' ? 'English' : '繁體中文';
  const { result } = await runStructured<ReportText>(deps.codex, {
    cwd,
    timeoutMs: 300_000,
    keepLanguage: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['oneLiner', 'background', 'scope', 'judged', 'changes', 'highlights', 'files'],
      properties: {
        oneLiner: { type: 'string' },
        background: { type: 'string' },
        scope: { type: 'string' },
        judged: { type: 'array', items: { type: 'string' } },
        changes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['title', 'before', 'after', 'captureKey'], properties: { title: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, captureKey: { type: 'string' } } },
        },
        highlights: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'purpose'], properties: { file: { type: 'string' }, purpose: { type: 'string' } } } },
      },
    },
    prompt: zhOnly(
      [
        `幫我寫 ${item.ticketKey} 的分析報告內容，給我自己理解這張單用（我是操作者，不是看程式碼的人）。全部用${lang}寫，白話、具體。`,
        '可以用 git diff、git show 看這張單實際改了什麼（對照基底分支），只讀不改。',
        '- oneLiner：一句話說這張單在解決什麼問題。',
        '- background：需求背景與要做什麼，兩三句。',
        '- scope：範圍：哪個專案、哪些商戶、前台或後台、哪些頁面。',
        '- judged：Jira 寫得模糊、由 AI 自己判斷的地方，一條一句；沒有就空陣列。',
        '- changes：每一項改動：title 一句話、before 改動前是什麼樣子、after 改動後是什麼樣子；captureKey 填對應的截圖 key（ac1、ac2…，沒有對應就空字串）。',
        '- highlights：最值得注意的三到五件事（例如會影響其他頁面、還沒確認的需求、風險）。',
        '- files：改到的檔案和各自做什麼，一個檔案一句。',
        '',
        '## 需求分析',
        reviewBrief(deps.review) || `${item.ticketKey} ${item.ticketSummary}`,
        '',
        '## 驗收表',
        JSON.stringify((report?.acceptance ?? []).map((a) => ({ no: a.no, text: a.text, result: a.result, note: a.note, change: a.change })), null, 0).slice(0, 8000),
        '',
        '## 截圖（key：改動前看到的／改動後看到的）',
        ...targets.map((x) => `- ${x.key}：${before.find((c) => c.key === x.key)?.note || '—'} ／ ${after.find((c) => c.key === x.key)?.note || '—'}`),
        '',
        '## 改動的檔案',
        diffStat,
      ].join('\n'),
    ),
  });

  deps.progress(t('排版、轉成 PDF'));
  const html = renderHtml(deps.dataDir, item, result, report?.acceptance ?? [], before, after, shotNote);
  const dir = join(deps.dataDir, '分析報告');
  mkdirSync(dir, { recursive: true });
  const htmlFile = join(dir, `${item.id}.html`);
  writeFileSync(htmlFile, html);
  const pdf = await toPdf(htmlFile);
  const out = join(homedir(), 'Desktop', `${item.ticketKey}-${t('分析報告')}.pdf`);
  writeFileSync(out, pdf);
  return out;
}

function renderHtml(dataDir: string, item: WorkItem, r: ReportText, acceptance: AcceptanceItem[], before: Capture[], after: Capture[], shotNote: string): string {
  const shotOf = (list: Capture[], key: string) => list.find((c) => c.key === key)?.shot;
  const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${esc(t('沒有'))}</p>`);
  const changes = r.changes
    .map((c) => {
      const b = img(dataDir, shotOf(before, c.captureKey));
      const a = img(dataDir, shotOf(after, c.captureKey)) || img(dataDir, acceptance.find((x) => `ac${x.no}` === c.captureKey)?.shot);
      return `<section class="change"><h3>${esc(c.title)}</h3>
        <div class="pair">
          <div><div class="tag before">${esc(t('改動前'))}</div>${b || `<div class="noshot">${esc(t('沒有截圖'))}</div>`}<p>${esc(c.before)}</p></div>
          <div><div class="tag after">${esc(t('改動後'))}</div>${a || `<div class="noshot">${esc(t('沒有截圖'))}</div>`}<p>${esc(c.after)}</p></div>
        </div></section>`;
    })
    .join('');
  const rows = acceptance
    .map((a) => {
      const who = needsYou(a) ? (a.checked ? t('你測過了') : t('還沒測')) : t('AI 測過');
      return `<tr><td>${a.no}</td><td>${esc(a.text)}${a.fromAi ? ` <span class="muted">（${esc(t('AI 整理'))}）</span>` : ''}</td><td>${esc(a.result)}</td><td>${esc(who)}</td><td>${esc(a.note)}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="${getLang() === 'en' ? 'en' : 'zh-Hant-TW'}"><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, 'PingFang TC', 'Helvetica Neue', sans-serif; color: #1d2433; margin: 0; padding: 28px 32px; font-size: 12.5px; line-height: 1.6; }
    h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 2px solid #2a6fd4; padding-bottom: 4px; color: #1b4f9c; }
    h3 { font-size: 13px; margin: 0 0 6px; } .muted { color: #6b7385; } .lead { font-size: 14px; font-weight: 600; margin: 10px 0; }
    .meta { color: #6b7385; font-size: 11.5px; } .change { break-inside: avoid; margin: 12px 0 16px; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .pair img { width: 100%; border: 1px solid #d5dae3; border-radius: 4px; }
    .tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 8px; margin-bottom: 4px; }
    .tag.before { background: #f3e3e3; color: #9c2b2b; } .tag.after { background: #e2f1e6; color: #1f7a3a; }
    .noshot { border: 1px dashed #c5ccd8; border-radius: 4px; padding: 30px 0; text-align: center; color: #8a92a3; }
    table { width: 100%; border-collapse: collapse; } td, th { border: 1px solid #d5dae3; padding: 4px 6px; vertical-align: top; text-align: left; } th { background: #eef2f8; }
    code { font-family: Menlo, monospace; font-size: 11px; }
  </style></head><body>
    <h1>${esc(item.ticketKey)} ${esc(item.ticketSummary)}</h1>
    <div class="meta">${esc(item.project)}${item.merchant ? ` m${item.merchant}` : ''} · ${esc(item.branch)} · ${esc(new Date().toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-TW'))}</div>
    <p class="lead">${esc(r.oneLiner)}</p>
    <h2>${esc(t('這張單要做什麼'))}</h2><p>${esc(r.background)}</p><p><strong>${esc(t('範圍'))}</strong>${esc(t('：'))}${esc(r.scope)}</p>
    ${r.judged.length ? `<p><strong>${esc(t('AI 自己判斷的地方'))}</strong></p>${list(r.judged)}` : ''}
    <h2>${esc(t('重點'))}</h2>${list(r.highlights)}
    <h2>${esc(t('改動前 vs 改動後'))}</h2>${shotNote ? `<p class="muted">${esc(shotNote)}</p>` : ''}${changes}
    <h2>${esc(t('驗收結果'))}</h2><table><tr><th>#</th><th>${esc(t('預期結果'))}</th><th>${esc(t('結果'))}</th><th>${esc(t('誰測的'))}</th><th>${esc(t('證據'))}</th></tr>${rows}</table>
    <h2>${esc(t('技術附錄'))}</h2><table><tr><th>${esc(t('檔案'))}</th><th>${esc(t('做什麼'))}</th></tr>${r.files.map((f) => `<tr><td><code>${esc(f.file)}</code></td><td>${esc(f.purpose)}</td></tr>`).join('')}</table>
    ${item.prs.length ? `<p>PR：${item.prs.map((p) => `${esc(p.target)} ${esc(p.url)}`).join('<br>')}</p>` : ''}
  </body></html>`;
}

async function toPdf(htmlFile: string): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
  try {
    await win.loadFile(htmlFile);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    win.destroy();
  }
}
