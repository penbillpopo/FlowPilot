// 寫死的文字改成多語系：
// 1. 開發的 AI 一段一段把英文換成 key，每做完一批就把 key 和英文附加到這張單的「多語系工作檔」（一行一個 JSON）；
//    不叫它在回覆裡一次寫出全部翻譯（實際發生過：幾十段 × 11 種語言太大，它一直說要做、卻每輪都草草結束）。
// 2. 它回覆最後寫「多語系進度：完成／未完成」；沒做完 FlowPilot 自動叫它繼續。
// 3. 做完後 FlowPilot 檢查 key 有沒有被用過（專案程式碼、遠端這個商戶的翻譯檔），
//    再另外開乾淨的 AI 分批翻成其他語言，寫進桌面的「多語系-MMDD.xlsx」。
// Excel 格式照交給翻譯的範本：Key、Type（商戶）、各語言一欄；同一天的檔案接著往下加，同一個 key＋商戶就更新那一列。
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 範本的語言欄位（順序照範本） */
export const I18N_LANGS = ['ja', 'en-us', 'th', 'tr', 'uz', 'vi', 'id', 'zh-cn', 'pt-br', 'ko', 'fr'] as const;
/** 要翻的語言（英文是原文） */
export const TRANSLATE_LANGS = I18N_LANGS.filter((l) => l !== 'en-us');
const HEADER = ['Key', 'Type', ...I18N_LANGS];

export interface I18nEntry {
  key: string;
  texts: Record<string, string>;
}

/** 這張單的多語系工作檔：AI 一批一批附加 key 和英文 */
export function i18nWorkFile(dataDir: string, itemId: number): string {
  return join(dataDir, '多語系', `${itemId}.jsonl`);
}

/** 讀工作檔：一行一個 {"key","en-us"}；同一個 key 以後面的為準，壞掉的行略過 */
export function readWorkFile(path: string): I18nEntry[] {
  if (!existsSync(path)) return [];
  const byKey = new Map<string, I18nEntry>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const data = JSON.parse(line);
      const key = String(data?.key ?? '').trim();
      const en = String(data?.['en-us'] ?? '').trim();
      if (key && en) byKey.set(key, { key, texts: { 'en-us': en } });
    } catch {}
  }
  return [...byKey.values()];
}

/** AI 回覆最後的「多語系進度：完成／未完成」；沒寫是 null */
export function parseProgress(message: string): 'done' | 'pending' | null {
  const last = [...message.matchAll(/多語系進度[：:]\s*(未完成|完成)/g)].at(-1)?.[1];
  return last === '完成' ? 'done' : last === '未完成' ? 'pending' : null;
}

/** 翻譯用的格式：每個 key 每種語言都要有 */
export const TRANSLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', ...TRANSLATE_LANGS],
        properties: Object.fromEntries([['key', { type: 'string' }], ...TRANSLATE_LANGS.map((l) => [l, { type: 'string' }])]),
      },
    },
  },
};

export function translationPrompt(entries: I18nEntry[]): string {
  return [
    '把下面網站介面上的英文翻成這些語言：' + TRANSLATE_LANGS.join('、') + '。',
    '- 這是線上娛樂城、體育投注網站的介面文字，用這類網站常見、自然的說法。',
    '- zh-cn 用簡體中文；pt-br 是巴西葡萄牙文；uz 用拉丁字母的烏茲別克文；id 是印尼文。',
    '- 變數（例如 ${0}、{{name}}）、HTML 標籤與實體（例如 &amp;）、網址、品牌和產品名稱照原樣保留，不要翻。',
    '- 每個 key 都要回，key 照原樣，每種語言都不能空白。',
    '',
    JSON.stringify(entries.map((e) => ({ key: e.key, en: e.texts['en-us'] }))),
  ].join('\n');
}

/** 把翻譯結果併回去；回傳還缺翻譯的 key */
export function mergeTranslations(entries: I18nEntry[], result: { entries?: Record<string, string>[] }): string[] {
  const got = new Map((result.entries ?? []).map((e) => [String(e.key), e]));
  const missing: string[] = [];
  for (const entry of entries) {
    const t = got.get(entry.key);
    if (!t || TRANSLATE_LANGS.some((l) => !String(t[l] ?? '').trim())) {
      missing.push(entry.key);
      continue;
    }
    for (const l of TRANSLATE_LANGS) entry.texts[l] = String(t[l]).trim();
  }
  return missing;
}

/** 翻過的翻譯：key＋英文一樣就直接沿用，不重翻（實際發生過：改了一次又全部重翻，多花 10 分鐘） */
export function translationCacheFile(dataDir: string): string {
  return join(dataDir, '多語系', '翻譯快取.json');
}
const cacheKey = (e: I18nEntry) => `${e.key}\u0000${e.texts['en-us']}`;

/** 從快取補上翻譯；回傳還要翻的 */
export function fillFromCache(entries: I18nEntry[], file: string): I18nEntry[] {
  let cache: Record<string, Record<string, string>> = {};
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  return entries.filter((e) => {
    const hit = cache[cacheKey(e)];
    if (!hit || TRANSLATE_LANGS.some((l) => !hit[l])) return true;
    Object.assign(e.texts, hit);
    return false;
  });
}

/** 翻好的存進快取 */
export function saveToCache(entries: I18nEntry[], file: string) {
  let cache: Record<string, Record<string, string>> = {};
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  for (const e of entries) {
    if (TRANSLATE_LANGS.every((l) => e.texts[l])) cache[cacheKey(e)] = Object.fromEntries(TRANSLATE_LANGS.map((l) => [l, e.texts[l]]));
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(cache));
}

/**
 * 分批翻譯（每批 10 條，同時翻 6 批）；翻不完整的那批再試一次。
 * AI 一個字一個字寫，一批寫得越多越慢：SEO 長段落 20 條一批、同時 3 批時，87 條要 10 分鐘（實際量過），所以批小一點、同時多一點。
 * ask 由呼叫的人提供（開一段乾淨的唯讀 AI 對話，照 TRANSLATION_SCHEMA 回答）。回傳最後還缺翻譯的 key。
 */
export async function translateAll(
  entries: I18nEntry[],
  ask: (prompt: string) => Promise<{ entries?: Record<string, string>[] }>,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<string[]> {
  const batches: I18nEntry[][] = [];
  for (let i = 0; i < entries.length; i += 10) batches.push(entries.slice(i, i + 10));
  const missing: string[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      let batch = batches[next++];
      for (let attempt = 0; attempt < 2 && batch.length; attempt++) {
        const left = await ask(translationPrompt(batch))
          .then((result) => mergeTranslations(batch, result))
          .catch(() => batch.map((e) => e.key));
        batch = batch.filter((e) => left.includes(e.key));
      }
      missing.push(...batch.map((e) => e.key));
      onProgress(++done, batches.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return missing;
}

/** 專案 environment.ts 裡翻譯檔的網址，換成這個商戶的（WebN） */
export function translateUrls(environmentSource: string, merchant: number): string[] {
  const urls = environmentSource.match(/https?:\/\/[^`'",\s]*\[lang\]\.json/g) ?? [];
  return [...new Set(urls.map((u) => u.replace(/\/Web\d+\//, `/Web${merchant}/`)))];
}

/** 遠端翻譯檔裡已經有的 key（每種語言、每個來源都看；讀不到的略過） */
export async function remoteKeys(urls: string[]): Promise<{ keys: Set<string>; read: number }> {
  const keys = new Set<string>();
  let read = 0;
  await Promise.all(
    urls.flatMap((url) =>
      I18N_LANGS.map(async (lang) => {
        try {
          const response = await fetch(url.replace('[lang]', lang), { signal: AbortSignal.timeout(15000) });
          if (!response.ok) return;
          for (const key of Object.keys(await response.json())) keys.add(key);
          read++;
        } catch {}
      }),
    ),
  );
  return { keys, read };
}

/** 開這條分支之前，專案程式碼裡已經用到的 key（看分支起點的程式碼，這次自己加的不算） */
export async function usedInCode(folder: string, baseBranch: string, keys: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  let base = 'HEAD';
  try {
    base = (await run('git', ['merge-base', 'HEAD', `origin/${baseBranch}`], { cwd: folder })).stdout.trim() || 'HEAD';
  } catch {}
  for (const key of keys) {
    try {
      const { stdout } = await run('git', ['grep', '-l', '-w', '-F', key, base, '--', 'src'], { cwd: folder });
      const files = stdout.split('\n').filter(Boolean).map((line) => line.slice(base.length + 1));
      if (files.length) found.set(key, files);
    } catch {} // git grep 找不到時會回傳錯誤碼
  }
  return found;
}

export function sheetPath(date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return join(homedir(), 'Desktop', `多語系-${mm}${dd}.xlsx`);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** 讀已經存在的檔案（可能被 Excel 存過，文字放在 sharedStrings）：回傳表頭以外的每一列 */
async function readRows(path: string): Promise<string[][]> {
  const part = async (name: string) => {
    try {
      return (await run('unzip', ['-p', path, name], { maxBuffer: 50 * 1024 * 1024 })).stdout;
    } catch {
      return '';
    }
  };
  const shared = [...(await part('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const rows: string[][] = [];
  for (const row of (await part('xl/worksheets/sheet1.xml')).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] ?? '';
      const value = /t="s"/.test(c[2])
        ? shared[Number(body.match(/<v>(\d+)<\/v>/)?.[1])] ?? ''
        : unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('') || (body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''));
      cells[columnIndex(c[1])] = value;
    }
    if (cells.some((v) => v)) rows.push(HEADER.map((_, i) => cells[i] ?? ''));
  }
  return rows.slice(1);
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, r) => {
      const style = r === 0 ? 1 : 2;
      const cs = cells
        .map((v, c) => (v ? `<c r="${columnName(c)}${r + 1}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>` : ''))
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols><col min="1" max="1" width="40" customWidth="1"/><col min="2" max="2" width="8" customWidth="1"/>' +
    `<col min="3" max="${HEADER.length}" width="40" customWidth="1"/></cols>` +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

const STATIC_PARTS: Record<string, string> = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  // 0：預設；1：表頭（粗體、灰底）；2：內容（自動換行、靠上）
  'xl/styles.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
};

/** 寫進桌面當天的檔案：已經有的列保留，同一個 key＋商戶就換成新的；回傳檔案路徑和這次寫了幾列 */
export async function writeI18nSheet(entries: I18nEntry[], merchant: number, path = sheetPath()): Promise<{ path: string; count: number }> {
  const rows = existsSync(path) ? await readRows(path) : [];
  for (const entry of entries) {
    const row = [entry.key, String(merchant), ...I18N_LANGS.map((lang) => entry.texts[lang] ?? '')];
    const at = rows.findIndex((r) => r[0] === entry.key && r[1] === String(merchant));
    if (at >= 0) rows[at] = row;
    else rows.push(row);
  }
  const dir = mkdtempSync(join(tmpdir(), 'flowpilot-i18n-'));
  try {
    for (const [name, content] of Object.entries({ ...STATIC_PARTS, 'xl/worksheets/sheet1.xml': sheetXml([HEADER, ...rows]) })) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const out = join(dir, 'out.xlsx');
    await run('zip', ['-q', '-X', '-r', out, '[Content_Types].xml', '_rels', 'xl'], { cwd: dir });
    writeFileSync(path, readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { path, count: entries.length };
}
