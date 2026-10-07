// Jira 查詢：連線資訊沿用 JiraMcpServer 的 .env 與權杖檔，權杖只在執行時讀取。
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { JiraTicket } from '../shared/types';
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

export async function getIssueContext(credentials: JiraCredentials, key: string, fetchImpl: typeof fetch = fetch): Promise<IssueContext> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const params = new URLSearchParams({ fields: 'summary,issuetype,description,comment,subtasks' });
  const response = await fetchImpl(`${credentials.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?${params}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`讀取 ${key} 失敗：HTTP ${response.status}`);
  const { fields } = (await response.json()) as {
    fields: {
      summary: string;
      issuetype: { name: string };
      description: unknown;
      comment?: { comments: { body: unknown }[] };
      subtasks?: { key: string; fields: { summary: string } }[];
    };
  };
  return {
    key: key.toUpperCase(),
    summary: fields.summary,
    issueType: fields.issuetype.name,
    description: adfToText(fields.description).replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT),
    // 最近 5 則留言
    comments: (fields.comment?.comments ?? []).slice(-5).map((c) => adfToText(c.body).trim().slice(0, 1500)),
    subtasks: (fields.subtasks ?? []).map((s) => ({ key: s.key, summary: s.fields.summary })),
  };
}
