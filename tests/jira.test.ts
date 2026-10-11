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

describe('拿掉原始需求', () => {
  const panel = (text: string) => ({ type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const para = (text: string, href?: string) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }] });
  const heading = (text: string) => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] });
  const doc = {
    type: 'doc',
    content: [
      panel('原始需求 / Merchant Requirements'),
      heading('User story'),
      para('商戶想要 All 選項'),
      heading('Acceptance criteria'),
      para('商戶寫的驗收條件'),
      para('商戶附的頁面', 'https://merchant.example.com/page'),
      panel('需求 / Requirements'),
      para('新增未存款、存款次數兩種條件'),
      panel('預期結果 / Acceptance Criteria'),
      para('勾選未存款時只有未存款玩家看得到'),
      panel('文档和设计图 / Document & Design'),
      para('Figma', 'https://www.figma.com/design/abc/x?node-id=1-2'),
    ],
  };

  it('整段拿掉（包括裡面商戶寫的 Acceptance criteria 小標題），保留需求、預期結果、文件與設計圖', async () => {
    const { adfToText, stripMerchantSection } = await import('../src/main/jira');
    const text = adfToText(stripMerchantSection(doc));
    expect(text).not.toContain('商戶');
    expect(text).not.toContain('Merchant');
    expect(text).toContain('需求 / Requirements');
    expect(text).toContain('新增未存款、存款次數兩種條件');
    expect(text).toContain('預期結果 / Acceptance Criteria');
    expect(text).toContain('勾選未存款時只有未存款玩家看得到');
    expect(text).toContain('文档和设计图');
  });

  it('原始需求段落裡的連結不會被擷取成參考資料', async () => {
    const { extractResources, stripMerchantSection } = await import('../src/main/jira');
    const urls = extractResources('ALL-1', [stripMerchantSection(doc)], []).map((r) => r.url);
    expect(urls).toEqual(['https://www.figma.com/design/abc/x?node-id=1-2']);
  });

  it('沒有面板結構的單（例如 AI 寫的需求文件）不受影響', async () => {
    const { adfToText, stripMerchantSection } = await import('../src/main/jira');
    const plain = { type: 'doc', content: [heading('Background / 背景'), para('內容')] };
    expect(adfToText(stripMerchantSection(plain))).toBe(adfToText(plain));
  });
});
