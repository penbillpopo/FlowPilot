// Jira 查詢：連線資訊沿用 JiraMcpServer 的 .env 與權杖檔，權杖只在執行時讀取。
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { JiraTicket, Resource, TicketSnapshot } from '../shared/types';
import { expandHome } from './settings';

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

/** 解析 .env（KEY=VALUE，一行一個，# 開頭是說明） */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export function loadCredentials(envFile: string): JiraCredentials {
  let env: Record<string, string>;
  try {
    env = parseEnv(readFileSync(envFile, 'utf8'));
  } catch {
    throw new Error(`讀不到 Jira 設定檔：${envFile}`);
  }
  const { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_TOKEN_FILE: tokenFile } = env;
  if (!baseUrl || !email || !tokenFile) throw new Error(`${envFile} 缺少 JIRA_BASE_URL、JIRA_EMAIL 或 JIRA_TOKEN_FILE`);
  const expanded = expandHome(tokenFile);
  const tokenPath = isAbsolute(expanded) ? expanded : resolve(dirname(envFile), expanded);
  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    throw new Error(`讀不到 Jira 權杖檔：${tokenPath}`);
  }
  if (!token) throw new Error(`Jira 權杖檔是空的：${tokenPath}`);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, token };
}

interface RawIssue {
  key: string;
  fields: {
    summary: string;
    updated: string;
    status: { name: string };
    issuetype: { name: string };
    parent?: { key: string; fields?: { summary?: string } };
  };
}

export function toTicket(issue: RawIssue, baseUrl: string): JiraTicket {
  const browse = (key: string) => `${baseUrl}/browse/${key}`;
  const { fields } = issue;
  return {
    key: issue.key.toUpperCase(),
    summary: fields.summary,
    status: fields.status.name,
    issueType: fields.issuetype.name,
    updated: fields.updated,
    url: browse(issue.key),
    parent: fields.parent
      ? { key: fields.parent.key.toUpperCase(), summary: fields.parent.fields?.summary ?? '', url: browse(fields.parent.key) }
      : null,
  };
}

/** 依 JQL 查詢，自動翻頁 */
export async function searchTickets(credentials: JiraCredentials, jql: string, fetchImpl: typeof fetch = fetch): Promise<JiraTicket[]> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const tickets: JiraTicket[] = [];
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({ jql, fields: 'summary,status,issuetype,parent,updated', maxResults: '100' });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    const response = await fetchImpl(`${credentials.baseUrl}/rest/api/3/search/jql?${params}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      const reason = response.status === 401 ? '帳號或權杖無效' : `HTTP ${response.status}`;
      throw new Error(`Jira 查詢失敗：${reason}`);
    }
    const body = (await response.json()) as { issues: RawIssue[]; nextPageToken?: string; isLast?: boolean };
    tickets.push(...body.issues.map((issue) => toTicket(issue, credentials.baseUrl)));
    nextPageToken = body.isLast === false ? body.nextPageToken : undefined;
  } while (nextPageToken);
  return tickets;
}

/** 一張單的完整內容（給 AI 判斷用） */
export interface IssueContext {
  key: string;
  summary: string;
  issueType: string;
  description: string;
  comments: string[];
  subtasks: { key: string; summary: string }[];
  /** 內文、留言、附件裡的參考資料 */
  resources: Resource[];
  /** 文字附件（.md、.txt…）的內容：單上常把 API 規格寫成附件 */
  textAttachments: { filename: string; text: string }[];
  /** 這個時間點的內容（用來比對 PM 有沒有改單） */
  snapshot: TicketSnapshot;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)\]】，。]+/g;

function classify(url: string): Resource['kind'] {
  if (/(^|\.)figma\.com\//.test(new URL(url).hostname + '/')) return 'figma';
  if (/atlassian\.net\/browse\//.test(url)) return 'jira';
  if (/\/_git\/.*\.(md|pdf|docx?|xlsx?)/i.test(url) || /docs\.google\.com|\/wiki\/|notion\.(so|site)|\.(pdf|docx?|xlsx?)(\?|$)/i.test(url)) return 'document';
  return 'link';
}

function titleOf(url: string, text: string | undefined, kind: Resource['kind']): string {
  if (text && text.trim() && text.trim() !== url) return text.trim();
  try {
    const u = new URL(url);
    if (kind === 'figma') {
      const name = decodeURIComponent(u.pathname.split('/')[3] ?? 'Figma').replace(/-+/g, ' ');
      const node = u.searchParams.get('node-id');
      return node ? `${name}（節點 ${node.replace('-', ':')}）` : name;
    }
    if (kind === 'jira') return u.pathname.split('/').pop() ?? url;
    const path = u.searchParams.get('path');
    if (path) return path.split('/').pop() ?? url;
    return `${u.hostname}${u.pathname.length > 1 ? u.pathname : ''}`.slice(0, 80);
  } catch {
    return url;
  }
}

/** 從 Jira 的內文格式（ADF）、留言與附件擷取參考資料；同一個網址只留一筆 */
export function extractResources(from: string, docs: unknown[], attachments: { filename: string; content: string }[]): Resource[] {
  const found = new Map<string, Resource>();
  const add = (url: string | undefined, text?: string) => {
    if (!url || !/^https?:\/\//.test(url)) return;
    const clean = url.replace(/[.,;:]+$/, '');
    if (found.has(clean)) return;
    const kind = classify(clean);
    found.set(clean, { kind, title: titleOf(clean, text, kind), url: clean, from });
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; attrs?: { url?: string }; marks?: { type: string; attrs?: { href?: string } }[]; content?: unknown[] };
    if (n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') add(n.attrs?.url);
    if (n.type === 'text') {
      const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href;
      if (link) add(link, n.text);
      else for (const match of (n.text ?? '').match(URL_IN_TEXT) ?? []) add(match);
    }
    walk(n.content ?? []);
  };
  docs.forEach(walk);
  for (const a of attachments) {
    if (!found.has(a.content)) found.set(a.content, { kind: 'attachment', title: a.filename, url: a.content, from });
  }
  return [...found.values()];
}

/** Jira 的內文格式（ADF）轉成純文字 */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { url?: string; text?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention' || n.type === 'emoji') return n.attrs?.text ?? '';
  if (n.type === 'inlineCard') return n.attrs?.url ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  if (n.type === 'listItem') return `- ${inner.trim()}\n`;
  if (['paragraph', 'heading', 'codeBlock', 'blockquote', 'tableRow'].includes(n.type ?? '')) return `${inner}\n`;
  if (n.type === 'tableCell' || n.type === 'tableHeader') return `${inner.trim()} | `;
  return inner;
}

const MAX_TEXT = 6000;

/** 「原始需求 / Merchant Requirements」段落的標題 */
const MERCHANT_SECTION = /原始需求|Merchant\s+Requirements/i;

/**
 * 拿掉「原始需求 / Merchant Requirements」整段：不交給 AI、不擷取裡面的連結、需求變更也不比對這段。
 * Jira 單的段落是用面板（panel）當標題，段落內容接在面板後面直到下一個面板；
 * 原始需求段落裡也可能有「Acceptance criteria」之類的小標題，那是商戶寫的，一起拿掉。
 * 要看的是「需求 / Requirements」與「預期結果 / Acceptance Criteria」。
 */
export function stripMerchantSection(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { content?: unknown[] }).content)) return doc;
  const kept: unknown[] = [];
  let skipping = false;
  for (const node of (doc as { content: unknown[] }).content) {
    if ((node as { type?: string })?.type === 'panel') skipping = MERCHANT_SECTION.test(adfToText(node));
    if (!skipping) kept.push(node);
  }
  return { ...(doc as object), content: kept };
}

export async function getIssueContext(credentials: JiraCredentials, key: string, fetchImpl: typeof fetch = fetch): Promise<IssueContext> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const params = new URLSearchParams({ fields: 'summary,issuetype,description,comment,subtasks,attachment' });
  const response = await fetchImpl(`${credentials.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?${params}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`讀取 ${key} 失敗：HTTP ${response.status}`);
  const { fields } = (await response.json()) as {
    fields: {
      summary: string;
      issuetype: { name: string };
      description: unknown;
      comment?: { comments: { id: string; body: unknown; updated?: string; author?: { displayName?: string } }[] };
      subtasks?: { key: string; fields: { summary: string } }[];
      attachment?: JiraAttachment[];
    };
  };
  const description = stripMerchantSection(fields.description);
  const fullDescription = adfToText(description).replace(/\n{3,}/g, '\n\n').trim();
  const snapshot: TicketSnapshot = {
    key: key.toUpperCase(),
    summary: fields.summary,
    description: fullDescription,
    comments: (fields.comment?.comments ?? []).map((c) => ({ id: c.id, author: c.author?.displayName ?? '', updated: c.updated ?? '', text: adfToText(c.body).trim() })),
    attachments: (fields.attachment ?? []).map((a) => a.filename),
    takenAt: new Date().toISOString(),
  };
  return {
    key: key.toUpperCase(),
    summary: fields.summary,
    issueType: fields.issuetype.name,
    snapshot,
    description: fullDescription.slice(0, MAX_TEXT),
    // 最近 5 則留言
    comments: (fields.comment?.comments ?? []).slice(-5).map((c) => adfToText(c.body).trim().slice(0, 1500)),
    subtasks: (fields.subtasks ?? []).map((s) => ({ key: s.key, summary: s.fields.summary })),
    resources: extractResources(key.toUpperCase(), [description, ...(fields.comment?.comments ?? []).map((c) => c.body)], fields.attachment ?? []),
    textAttachments: await readTextAttachments(fields.attachment ?? [], auth, fetchImpl),
  };
}

interface JiraAttachment {
  filename: string;
  /** 下載網址 */
  content: string;
  mimeType?: string;
  size?: number;
}

const TEXT_FILE = /\.(md|markdown|txt)$/i;
/** 超過這個大小的附件不下載 */
const MAX_ATTACHMENT_BYTES = 200_000;
/** 每個附件、所有附件加起來最多給 AI 看多少字 */
const MAX_ATTACHMENT_TEXT = 8000;
const MAX_ATTACHMENTS_TEXT = 20000;

/** 讀文字附件（.md、.txt 或 Jira 標成文字的）；圖片、PDF 不讀，單一個讀不到就略過 */
export async function readTextAttachments(attachments: JiraAttachment[], auth: string, fetchImpl: typeof fetch = fetch): Promise<{ filename: string; text: string }[]> {
  const result: { filename: string; text: string }[] = [];
  let total = 0;
  for (const a of attachments) {
    if (!TEXT_FILE.test(a.filename) && !/^text\//.test(a.mimeType ?? '')) continue;
    if ((a.size ?? 0) > MAX_ATTACHMENT_BYTES || total >= MAX_ATTACHMENTS_TEXT) continue;
    try {
      const response = await fetchImpl(a.content, { headers: { Authorization: `Basic ${auth}` } });
      if (!response.ok) continue;
      let text = (await response.text()).trim();
      const limit = Math.min(MAX_ATTACHMENT_TEXT, MAX_ATTACHMENTS_TEXT - total);
      if (text.length > limit) text = `${text.slice(0, limit)}\n…（後面省略）`;
      total += text.length;
      if (text) result.push({ filename: a.filename, text });
    } catch {
      // 讀不到就略過，不影響審閱
    }
  }
  return result;
}

/** 狀態名稱（Jira 上顯示的，可能是翻譯過的）→ 狀態編號。同一個名稱可能對到好幾個編號 */
export async function statusIdsByName(credentials: JiraCredentials, fetchImpl: typeof fetch = fetch): Promise<Map<string, string[]>> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const response = await fetchImpl(`${credentials.baseUrl}/rest/api/3/status`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`讀取 Jira 狀態清單失敗：HTTP ${response.status}`);
  const map = new Map<string, string[]>();
  for (const status of (await response.json()) as { id: string; name: string; untranslatedName?: string }[]) {
    for (const name of new Set([status.name, status.untranslatedName].filter(Boolean) as string[])) {
      const key = name.toLowerCase();
      map.set(key, [...(map.get(key) ?? []), status.id]);
    }
  }
  return map;
}

/** 組查詢條件：基本條件 + 選的狀態（用編號，不受翻譯與大小寫影響） */
export function buildJql(filter: string, statusNames: string[], ids: Map<string, string[]>): string {
  const unknown = statusNames.filter((n) => !ids.has(n.toLowerCase()));
  if (unknown.length) throw new Error(`Jira 上找不到這些狀態：${unknown.join('、')}`);
  const statusIds = [...new Set(statusNames.flatMap((n) => ids.get(n.toLowerCase())!))];
  if (statusIds.length === 0) throw new Error('至少要選一個狀態');
  return `${filter} AND status in (${statusIds.join(', ')}) ORDER BY updated DESC`;
}
