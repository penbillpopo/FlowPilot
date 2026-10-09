import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCredentials, parseEnv, searchTickets } from '../src/main/jira';
import { mainTicketKey } from '../src/shared/types';

const credentials = { baseUrl: 'https://example.atlassian.net', email: 'me@example.com', token: 'secret' };

function issue(key: string, parent?: { key: string; summary: string }) {
  return {
    key,
    fields: {
      summary: `${key} 標題`,
      updated: '2026-10-07T09:00:00.000+0800',
      status: { name: '進行中' },
      issuetype: { name: parent ? '子任務' : '故事' },
      ...(parent ? { parent: { key: parent.key, fields: { summary: parent.summary } } } : {}),
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('.env 解析', () => {
  it('忽略說明與空行，去掉引號', () => {
    expect(parseEnv('# 說明\nA=1\n\nB = "two"\nC=\'3\'\n')).toEqual({ A: '1', B: 'two', C: '3' });
  });

  it('權杖檔用相對路徑時，以 .env 所在資料夾為準', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpilot-'));
    writeFileSync(join(dir, '.env'), 'JIRA_BASE_URL=https://x.atlassian.net/\nJIRA_EMAIL=me@x.com\nJIRA_TOKEN_FILE=./token.txt\n');
    writeFileSync(join(dir, 'token.txt'), '  abc123\n');
    expect(loadCredentials(join(dir, '.env'))).toEqual({ baseUrl: 'https://x.atlassian.net', email: 'me@x.com', token: 'abc123' });
  });

  it('缺欄位時報錯，訊息不含權杖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpilot-'));
    writeFileSync(join(dir, '.env'), 'JIRA_BASE_URL=https://x.atlassian.net\n');
    expect(() => loadCredentials(join(dir, '.env'))).toThrow('缺少');
  });
});

describe('Jira 查詢', () => {
  it('子任務帶出主單，主單本身沒有上層', async () => {
    const fetchImpl = async () =>
      jsonResponse({ issues: [issue('ALL-14734', { key: 'ALL-14699', summary: '主單標題' }), issue('ALL-14493')], isLast: true });
    const [sub, story] = await searchTickets(credentials, 'jql', fetchImpl as typeof fetch);
    expect(sub.parent).toEqual({ key: 'ALL-14699', summary: '主單標題', url: 'https://example.atlassian.net/browse/ALL-14699' });
    expect(mainTicketKey(sub)).toBe('ALL-14699');
    expect(story.parent).toBeNull();
    expect(mainTicketKey(story)).toBe('ALL-14493');
  });

  it('自動翻頁，並帶上驗證資訊', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('me@example.com:secret').toString('base64')}`);
      return calls.length === 1
        ? jsonResponse({ issues: [issue('ALL-1')], nextPageToken: 'p2', isLast: false })
        : jsonResponse({ issues: [issue('ALL-2')], isLast: true });
    };
    const tickets = await searchTickets(credentials, 'status = "進行中"', fetchImpl as unknown as typeof fetch);
    expect(tickets.map((t) => t.key)).toEqual(['ALL-1', 'ALL-2']);
    expect(new URL(calls[1]).searchParams.get('nextPageToken')).toBe('p2');
    expect(new URL(calls[0]).searchParams.get('jql')).toBe('status = "進行中"');
  });

  it('權杖無效時給看得懂的錯誤', async () => {
    const fetchImpl = async () => jsonResponse({}, 401);
    await expect(searchTickets(credentials, 'jql', fetchImpl as typeof fetch)).rejects.toThrow('帳號或權杖無效');
  });
});

describe('Jira 內文轉文字', () => {
  it('段落、清單、換行、提及', async () => {
    const { adfToText } = await import('../src/main/jira');
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: '需求' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第一行' }, { type: 'hardBreak' }, { type: 'text', text: '第二行' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '項目' }] }] }] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@ban' } }] },
      ],
    };
    expect(adfToText(doc)).toBe('需求\n第一行\n第二行\n- 項目\n@ban\n');
  });
});

describe('狀態篩選', () => {
  it('名稱換成編號（同名的全部帶上），不分大小寫', async () => {
    const { buildJql, statusIdsByName } = await import('../src/main/jira');
    const fetchImpl = async () =>
      jsonResponse([
        { id: '10001', name: '進行中', untranslatedName: 'In Progress' },
        { id: '10049', name: '進行中', untranslatedName: 'In progress' },
        { id: '10042', name: 'UAT', untranslatedName: 'UAT' },
      ]);
    const ids = await statusIdsByName(credentials, fetchImpl as typeof fetch);
    expect(buildJql('assignee = currentUser()', ['進行中', 'uat'], ids)).toBe('assignee = currentUser() AND status in (10001, 10049, 10042) ORDER BY updated DESC');
    expect(() => buildJql('x', ['不存在'], ids)).toThrow('找不到這些狀態：不存在');
    expect(() => buildJql('x', [], ids)).toThrow('至少要選一個狀態');
  });
});

describe('參考資料擷取', () => {
  it('從內文、留言、附件抓出 Figma、文件、Jira、網頁、附件，並去掉重複', async () => {
    const { extractResources } = await import('../src/main/jira');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'ALL-14396.md', marks: [{ type: 'link', attrs: { href: 'https://org.visualstudio.com/p/_git/Core?path=/requirements/ALL-14396.md&version=GBmaster' } }] }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://www.figma.com/design/FmHY/PS---Production-SOT?node-id=5618-36404' } }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://other.atlassian.net/browse/GBR-379' } }] },
        { type: 'paragraph', content: [{ type: 'text', text: '後台頁面：https://uat.admin.example.com/bonus/event，請參考。' }] },
      ],
    };
    const comment = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://www.figma.com/design/FmHY/PS---Production-SOT?node-id=5618-36404' } }] }] };
    const resources = extractResources('ALL-14396', [doc, comment], [{ filename: 'image-1.png', content: 'https://x.atlassian.net/rest/api/3/attachment/content/1' }]);
    expect(resources.map((r) => [r.kind, r.title])).toEqual([
      ['document', 'ALL-14396.md'],
      ['figma', 'PS Production SOT（節點 5618:36404）'],
      ['jira', 'GBR-379'],
      ['link', 'uat.admin.example.com/bonus/event'],
      ['attachment', 'image-1.png'],
    ]);
    expect(resources.every((r) => r.from === 'ALL-14396')).toBe(true);
  });
});
