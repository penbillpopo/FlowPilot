// 本機要連 SIT 還是 UAT：environment.ts 裡兩組設定都寫好了，只靠註解切換，從來不改值。
// 標記：PlatformWeb 是「// sit分支本地调试使用这个」「// uat分支本地调试使用这个」；
// PlatformAdmin、GoMoneyAdmin 是「/** SIT */」「/** UAT */」。
// 標記下面接著的程式碼行算同一組，碰到空行或下一個標記就結束。
// 另外 PlatformWeb 有「// uat使用sit的翻译，调试需要解除此注释」：UAT 用 SIT 的多語系，
// 這個標記下面的 environment.xxx = … 行切到 UAT 時打開、切回 SIT 時註解掉。
import { t } from '../shared/i18n';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../shared/types';

export type { Env };

export const ENVIRONMENT_FILE = 'src/environments/environment.ts';

const MARKERS: Record<Env, RegExp[]> = {
  sit: [/^\s*\/\/\s*sit分支/i, /^\s*\/\*\*\s*SIT\s*\*\/\s*$/],
  uat: [/^\s*\/\/\s*uat分支/i, /^\s*\/\*\*\s*UAT\s*\*\/\s*$/],
};

function markerOf(line: string): Env | null {
  for (const env of ['sit', 'uat'] as Env[]) if (MARKERS[env].some((re) => re.test(line))) return env;
  return null;
}

const isCommented = (line: string) => /^\s*\/\//.test(line);

/** 設定行的名稱：`apiUrl: '…',`、`const tenant = '…';`（前面可以有 // ） */
function keyOf(line: string): string | null {
  return line.match(/^\s*(?:\/\/\s*)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*[:=]/)?.[1] ?? null;
}

/**
 * 兩組設定各在第幾行（從 0 算）。標記下面連續的設定行算同一組，碰到空行、下一個標記或不是設定的行就停；
 * 兩組要一一對應同樣的名稱（例如都是 apiUrl、tenant），對不上的行一律不碰。
 */
function blocks(lines: string[]): Record<Env, number[]> | null {
  const found: Partial<Record<Env, number[]>> = {};
  for (let i = 0; i < lines.length; i++) {
    const env = markerOf(lines[i]);
    if (!env || found[env]) continue;
    const rows: number[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== '' && !markerOf(lines[j]) && keyOf(lines[j]); j++) rows.push(j);
    found[env] = rows;
  }
  if (!found.sit || !found.uat) return null;
  let n = 0;
  while (n < found.sit.length && n < found.uat.length && keyOf(lines[found.sit[n]]) === keyOf(lines[found.uat[n]])) n++;
  return n ? { sit: found.sit.slice(0, n), uat: found.uat.slice(0, n) } : null;
}

/** 目前是哪個環境；'mixed' 表示兩組都開著或都註解掉，null 表示找不到標記 */
export function detectEnvironment(text: string): Env | 'mixed' | null {
  const b = blocks(text.split('\n'));
  if (!b) return null;
  const lines = text.split('\n');
  const on = (env: Env) => b[env].every((i) => !isCommented(lines[i]));
  const off = (env: Env) => b[env].every((i) => isCommented(lines[i]));
  if (on('sit') && off('uat')) return 'sit';
  if (on('uat') && off('sit')) return 'uat';
  return 'mixed';
}

const UAT_EXTRA_MARKER = /^\s*\/\/\s*uat使用sit/i;

/** 只有 UAT 才要打開的行（標記下面連續的 environment.xxx = … 行） */
function uatExtras(lines: string[]): number[] {
  const rows: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!UAT_EXTRA_MARKER.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && /^\s*(?:\/\/\s*)?environment\.[\w$]+\s*=/.test(lines[j]); j++) rows.push(j);
  }
  return rows;
}

const uncomment = (line: string) => line.replace(/^(\s*)\/\/ ?/, '$1');
const comment = (line: string) => (isCommented(line) ? line : line.replace(/^(\s*)/, '$1// '));

/** 打開目標那組的註解、註解掉另一組；只有 UAT 才要的行跟著切換；其他行原封不動 */
export function switchEnvironment(text: string, target: Env): string {
  const lines = text.split('\n');
  const b = blocks(lines);
  if (!b) throw new Error(t('environment.ts 裡找不到 SIT／UAT 的標記'));
  const other: Env = target === 'sit' ? 'uat' : 'sit';
  for (const i of b[target]) lines[i] = uncomment(lines[i]);
  for (const i of b[other]) lines[i] = comment(lines[i]);
  for (const i of uatExtras(lines)) lines[i] = target === 'uat' ? uncomment(lines[i]) : comment(lines[i]);
  return lines.join('\n');
}

/** 目前開著的那組設定裡，某個名稱的值（例如 apiUrl）；找不到就是 null */
export function activeValue(text: string, key: string): string | null {
  const lines = text.split('\n');
  const b = blocks(lines);
  if (!b) return null;
  for (const env of ['sit', 'uat'] as Env[]) {
    for (const i of b[env]) {
      if (isCommented(lines[i]) || keyOf(lines[i]) !== key) continue;
      return lines[i].match(/[:=]\s*['"`]([^'"`]+)['"`]/)?.[1] ?? null;
    }
  }
  return null;
}

/** SIT、UAT 兩組設定裡的後端主機（例如 sit-newplatform.mxsyl.com），給測試瀏覽器分辨哪些是專案自己的 API */
export function apiHosts(folder: string): string[] {
  const file = join(folder, ENVIRONMENT_FILE);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const b = blocks(lines);
  if (!b) return [];
  const hosts = new Set<string>();
  for (const i of [...b.sit, ...b.uat]) {
    if (keyOf(lines[i]) !== 'apiUrl') continue;
    const url = lines[i].match(/[:=]\s*['"`]([^'"`]+)['"`]/)?.[1];
    try {
      if (url) hosts.add(new URL(url).host);
    } catch {}
  }
  return [...hosts];
}

/** 讀資料夾目前開著的後端網址；讀不到就是 null */
export function readApiUrl(folder: string): string | null {
  const file = join(folder, ENVIRONMENT_FILE);
  return existsSync(file) ? activeValue(readFileSync(file, 'utf8'), 'apiUrl') : null;
}

/** 讀資料夾目前的環境；沒有這個檔案就是 null */
export function readEnvironment(folder: string): Env | 'mixed' | null {
  const file = join(folder, ENVIRONMENT_FILE);
  return existsSync(file) ? detectEnvironment(readFileSync(file, 'utf8')) : null;
}

export function setEnvironment(folder: string, target: Env): void {
  const file = join(folder, ENVIRONMENT_FILE);
  const text = readFileSync(file, 'utf8');
  const next = switchEnvironment(text, target);
  if (next !== text) writeFileSync(file, next);
}
