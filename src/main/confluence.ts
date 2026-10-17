// 讀 Confluence 頁面當補充資料（只讀，跟 Jira 用同一組帳號）。
// 一大張問題表（例如 M10 的 QA 問題清單）不整頁給 AI：照單號標題的 [A#17] 找出第 17 列，只給那一列和它的截圖。
import { t, zhOnly } from '../shared/i18n';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraCredentials } from './jira';

export interface Supplement {
  /** 從哪裡來（給人和 AI 看） */
  label: string;
  text: string;
  /** 下載到本機的截圖 */
  images: string[];
}

/** 頁面編號：…/pages/594837551/M10 或 ?pageId=594837551 */
export function confluencePageId(url: string): string | null {
  return url.match(/\/pages\/(\d+)/)?.[1] ?? url.match(/[?&]pageId=(\d+)/)?.[1] ?? null;
}

/** 單號標題裡的問題編號：[A#17]、#17 */
export function issueNumbers(titles: string[]): string[] {
  return [...new Set(titles.map((t) => t.match(/\[[A-Za-z]*#(\d+)\]/)?.[1] ?? t.match(/#(\d+)\b/)?.[1]).filter((n): n is string => !!n))];
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Confluence 的儲存格式轉成純文字：狀態標籤留文字、@ 人寫成「@某人」、圖片寫成 [圖片] */
export function storageToText(html: string): string {
  return decode(
    html
      .replace(/<ac:structured-macro ac:name="status"[\s\S]*?<ac:parameter ac:name="title">([^<]*)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/g, '［$1］')
      .replace(/<ac:link>\s*<ri:user[^>]*\/>\s*<\/ac:link>/g, '@某人')
      .replace(/<ac:image[\s\S]*?<\/ac:image>/g, '［圖片］')
      .replace(/<ac:emoticon[^>]*\/>/g, '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|h\d|li|tr)>/g, '\n')
      .replace(/<\/t[hd]>/g, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cellsOf = (row: string) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]);
const cellText = (cell: string) => storageToText(cell).replace(/\s*\|\s*$/, '').replace(/\n+/g, ' ').trim();

/** 一格裡的圖片（頁面附件的檔名；內嵌連結取網址最後一段）。直接用網址下載會被擋（401），要用檔名查附件再下載 */
function imageFiles(cell: string): string[] {
  const files: string[] = [];
  for (const m of cell.matchAll(/<ac:image[\s\S]*?<\/ac:image>/g)) {
    const file = m[0].match(/ri:filename="([^"]+)"/)?.[1];
    const url = m[0].match(/ri:value="([^"]+)"/)?.[1] ?? m[0].match(/ac:src="([^"]+)"/)?.[1];
    const name = file ?? (url ? decodeURIComponent(decode(url).split('?')[0].split('/').pop() ?? '') : '');
    if (name) files.push(decode(name));
  }
  return files;
}

/** 在頁面的表格裡找第一欄是這個編號的列：回傳「欄位：內容」的文字和那一列的圖片網址 */
export function findRow(html: string, number: string): { text: string; images: string[] } | null {
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const header = rows[0] ? cellsOf(rows[0]).map(cellText) : [];
    for (const row of rows.slice(1)) {
      const cells = cellsOf(row);
      if (!cells.length || cellText(cells[0]) !== number) continue;
      const lines = cells
        .map((c, i) => [header[i] || `第 ${i + 1} 欄`, cellText(c)] as const)
        .filter(([, v]) => v && v !== '［圖片］')
        .map(([k, v]) => `${k}：${v}`);
      return { text: lines.join('\n'), images: cells.flatMap(imageFiles) };
    }
  }
  return null;
}

const auth = (c: JiraCredentials) => 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64');

/** 讀一個 Confluence 頁面當補充資料；有問題編號就只取那幾列（找不到就整頁，太長截斷） */
export async function loadConfluence(
  credentials: JiraCredentials,
  url: string,
  ticketTitles: string[],
  imageDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Supplement> {
  const pageId = confluencePageId(url);
  if (!pageId) throw new Error(t('看不出這是哪個 Confluence 頁面：{url}', { url }));
  const response = await fetchImpl(`${credentials.baseUrl}/wiki/api/v2/pages/${pageId}?body-format=storage`, {
    headers: { Authorization: auth(credentials), Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(t('讀不到 Confluence 頁面（HTTP {status}）：{url}', { status: response.status, url }));
  const page = (await response.json()) as { title?: string; body?: { storage?: { value?: string } } };
  const html = page.body?.storage?.value ?? '';
  const title = page.title ?? pageId;

  const rows = issueNumbers(ticketTitles)
    .map((n) => ({ n, row: findRow(html, n) }))
    .filter((r): r is { n: string; row: { text: string; images: string[] } } => !!r.row);
  const images: string[] = [];
  const wanted = rows.length ? rows.flatMap((r) => r.row.images) : [];
  for (const [i, name] of wanted.slice(0, 6).entries()) {
    try {
      const found = await fetchImpl(`${credentials.baseUrl}/wiki/api/v2/pages/${pageId}/attachments?filename=${encodeURIComponent(name)}`, {
        headers: { Authorization: auth(credentials), Accept: 'application/json' },
      });
      const link = found.ok ? ((await found.json()) as { results?: { downloadLink?: string }[] }).results?.[0]?.downloadLink : undefined;
      if (!link) continue;
      const img = await fetchImpl(`${credentials.baseUrl}/wiki${link}`, { headers: { Authorization: auth(credentials) } });
      if (!img.ok) continue;
      mkdirSync(imageDir, { recursive: true });
      const file = join(imageDir, `confluence-${pageId}-${i}${name.match(/\.(png|jpe?g|gif|webp)$/i)?.[0] ?? '.png'}`);
      writeFileSync(file, Buffer.from(await img.arrayBuffer()));
      images.push(file);
    } catch {}
  }
  if (rows.length) {
    return {
      label: zhOnly(`Confluence「${title}」第 ${rows.map((r) => r.n).join('、')} 列`),
      text: rows.map((r) => `【第 ${r.n} 列】\n${r.row.text}`).join('\n\n'),
      images,
    };
  }
  const text = storageToText(html);
  return { label: zhOnly(`Confluence「${title}」`), text: text.length > 15000 ? `${text.slice(0, 15000)}\n…（後面省略）` : text, images };
}
