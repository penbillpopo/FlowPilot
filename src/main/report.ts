// 分析報告（自己理解用）：這張單要做什麼、改動說明（附測試時截的畫面）、重點、驗收結果、技術附錄，存成桌面的 PDF。
// 截圖用測試過程中 AI 截的（每一條驗收項目一張），不另外開網站重新截：
// 以前產生報告時會重開網站、重新登入截圖，測試帳號被停用就一張都截不到，還要重啟你的本機網站（實際發生過）。
// 只讀紀錄、截圖和 git，不改程式、不推送、不發到 Jira。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { getLang, t, zhOnly } from '../shared/i18n';
import type { AcceptanceItem, Review, WorkItem } from '../shared/types';
import { needsYou } from '../shared/acceptance';
import type { CodexRpc } from './codex/rpc';
import { runStructured } from './codex/structured';
import { reviewBrief } from './planner/review';

export interface ReportDeps {
  codex: CodexRpc;
  dataDir: string;
  /** 讀 git 改動用的資料夾（這張單的資料夾；讓出了就用同專案的資料夾讀遠端分支） */
  cwd: string;
  /** git diff 的比較對象：這張單的資料夾就是 HEAD，讓出了就是遠端分支 */
  head: string;
  review: Review | null;
  log(message: string): void;
  progress(text: string): void;
}

const run = (cwd: string, args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) =>
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout: String(stdout ?? '') })),
  );

const SHOT = /^[\w.\-]+\.png$/i;

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
  changes: { title: string; before: string; after: string; acceptanceNo: number }[];
  highlights: string[];
  files: { file: string; purpose: string }[];
}

/** 產生分析報告，存到桌面，回傳檔案路徑 */
export async function generateReport(deps: ReportDeps, item: WorkItem): Promise<string> {
  const acceptance = item.testReport?.acceptance ?? [];
  const shots = acceptance.filter((a) => a.shot && existsSync(join(deps.dataDir, '瀏覽器測試紀錄', a.shot)));
  const shotNote = !acceptance.length ? t('驗收表沒有項目，沒有截圖') : !shots.length ? t('測試時沒有截到畫面（截圖會在 AI 瀏覽器測試時自動截）') : '';

  deps.progress(t('AI 整理報告內容'));
  const diffStat = (await run(deps.cwd, ['diff', '--stat', `origin/${item.baseBranch}...${deps.head}`])).stdout.slice(0, 4000);
  const lang = getLang() === 'en' ? 'English' : '繁體中文';
  const { result } = await runStructured<ReportText>(deps.codex, {
    cwd: deps.cwd,
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
          items: { type: 'object', additionalProperties: false, required: ['title', 'before', 'after', 'acceptanceNo'], properties: { title: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, acceptanceNo: { type: 'number' } } },
        },
        highlights: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'purpose'], properties: { file: { type: 'string' }, purpose: { type: 'string' } } } },
      },
    },
    prompt: zhOnly(
      [
        `幫我寫 ${item.ticketKey} 的分析報告內容，給我自己理解這張單用（我是操作者，不是看程式碼的人）。全部用${lang}寫，白話、具體。`,
        `可以用 git diff、git show 看這張單實際改了什麼（git diff origin/${item.baseBranch}...${deps.head}），只讀不改。`,
        '- oneLiner：一句話說這張單在解決什麼問題。',
        '- background：需求背景與要做什麼，兩三句。',
        '- scope：範圍：哪個專案、哪些商戶、前台或後台、哪些頁面。',
        '- judged：Jira 寫得模糊、由 AI 自己判斷的地方，一條一句；沒有就空陣列。',
        '- changes：每一項改動：title 一句話、before 改動前是什麼樣子、after 改動後是什麼樣子；acceptanceNo 填最相關的驗收項目編號（那一條的測試截圖會放在旁邊），沒有就填 0。',
        '- highlights：最值得注意的三到五件事（例如會影響其他頁面、還沒確認的需求、風險）。',
        '- files：改到的檔案和各自做什麼，一個檔案一句。',
        '',
        '## 需求分析',
        reviewBrief(deps.review) || `${item.ticketKey} ${item.ticketSummary}`,
        '',
        '## 驗收表（has_shot：測試時有截圖）',
        JSON.stringify(acceptance.map((a) => ({ no: a.no, text: a.text, result: a.result, note: a.note, change: a.change, has_shot: shots.includes(a) }))).slice(0, 8000),
        '',
        '## 改動的檔案',
        diffStat,
      ].join('\n'),
    ),
  });

  deps.progress(t('排版、轉成 PDF'));
  const html = renderHtml(deps.dataDir, item, result, acceptance, shotNote);
  const dir = join(deps.dataDir, '分析報告');
  mkdirSync(dir, { recursive: true });
  const htmlFile = join(dir, `${item.id}.html`);
  writeFileSync(htmlFile, html);
  const pdf = await toPdf(htmlFile);
  const out = join(homedir(), 'Desktop', `${item.ticketKey}-${t('分析報告')}.pdf`);
  writeFileSync(out, pdf);
  return out;
}

function renderHtml(dataDir: string, item: WorkItem, r: ReportText, acceptance: AcceptanceItem[], shotNote: string): string {
  const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${esc(t('沒有'))}</p>`);
  // 每項改動：前後說明並排；有對應驗收項目的測試截圖就放在下面（測試時截的是改動後的畫面）
  const changes = r.changes
    .map((c) => {
      const shot = img(dataDir, acceptance.find((x) => x.no === c.acceptanceNo)?.shot);
      return `<section class="change"><h3>${esc(c.title)}</h3>
        <div class="pair">
          <div><div class="tag before">${esc(t('改動前'))}</div><p>${esc(c.before)}</p></div>
          <div><div class="tag after">${esc(t('改動後'))}</div><p>${esc(c.after)}</p></div>
        </div>${shot ? `<figure>${shot}<figcaption class="muted">${esc(t('測試時的畫面（改動後）'))}</figcaption></figure>` : ''}</section>`;
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
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } figure { margin: 8px 0 0; } figure img { width: 100%; max-height: 520px; object-fit: contain; border: 1px solid #d5dae3; border-radius: 4px; }
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
    <h2>${esc(t('改動說明'))}</h2>${shotNote ? `<p class="muted">${esc(shotNote)}</p>` : ''}${changes}
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
