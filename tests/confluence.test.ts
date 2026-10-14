// 補充資料：讀 Confluence（只讀）。問題表只取這張單的那一列和截圖
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { confluencePageId, findRow, issueNumbers, loadConfluence, storageToText } from '../src/main/confluence';

// 照實際的 M10 問題表格式（狀態標籤、@ 人、內嵌截圖）
const TABLE = `<table><tbody>
<tr><th><p>編號</p></th><th><p>功能</p></th><th><p>描述</p></th><th><p>截图</p></th><th><p>修复状态</p></th><th><p>RD负责人</p></th></tr>
<tr><td><p><strong>17</strong></p></td><td><p>Profile</p></td><td><p>Incognito Mode<br />首次进入时预设状态错误<br />＊M8无此问题</p></td>
<td><ac:image ac:alt="a.png" ac:src="https://x.atlassian.net/wiki/download/attachments/594837551/a.png"><ri:url ri:value="https://x.atlassian.net/wiki/download/attachments/594837551/a.png" /></ac:image></td>
<td><p><ac:structured-macro ac:name="status"><ac:parameter ac:name="title">TO-DO</ac:parameter></ac:structured-macro></p></td>
<td><p><ac:link><ri:user ri:account-id="1" /></ac:link></p></td></tr>
<tr><td><p>18</p></td><td><p>Notifications</p></td><td><p>未讀點點不會消失</p></td><td></td><td></td><td></td></tr>
</tbody></table>`;

describe('讀 Confluence 當補充資料', () => {
  it('從網址讀出頁面編號；從單號標題讀出問題編號', () => {
    expect(confluencePageId('https://inta.atlassian.net/wiki/spaces/PM/pages/594837551/M10')).toBe('594837551');
    expect(confluencePageId('https://x/wiki/pages/viewpage.action?pageId=123')).toBe('123');
    expect(issueNumbers(['[A#17] Profile - Fix', '[A#18] Notifications', '沒有編號'])).toEqual(['17', '18']);
  });

  it('問題表只取那一列：欄位名稱對內容、狀態標籤留文字、@ 人、截圖檔名', () => {
    const row = findRow(TABLE, '17')!;
    expect(row.text).toBe('編號：17\n功能：Profile\n描述：Incognito Mode 首次进入时预设状态错误 ＊M8无此问题\n修复状态：［TO-DO］\nRD负责人：@某人');
    expect(row.images).toEqual(['a.png']);
    expect(findRow(TABLE, '99')).toBeNull();
    expect(storageToText('<p>a<br/>b</p><p>c</p>')).toBe('a\nb\nc');
  });

  it('讀頁面：有問題編號就只給那幾列，截圖用附件查詢下載（直接用網址會被擋）', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes('/pages/594837551?')) return new Response(JSON.stringify({ title: 'M10测试', body: { storage: { value: TABLE } } }));
      if (url.includes('/attachments?filename=a.png')) return new Response(JSON.stringify({ results: [{ downloadLink: '/rest/api/content/1/child/attachment/9/download' }] }));
      if (url.endsWith('/wiki/rest/api/content/1/child/attachment/9/download')) return new Response(new Uint8Array([1, 2, 3]));
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'fp-conf-'));
    const s = await loadConfluence({ baseUrl: 'https://x.atlassian.net', email: 'a', token: 't' }, 'https://x.atlassian.net/wiki/spaces/PM/pages/594837551/M10', ['[A#17] Profile'], dir, fake);
    expect(s.label).toBe('Confluence「M10测试」第 17 列');
    expect(s.text).toContain('描述：Incognito Mode');
    expect(s.text).not.toContain('Notifications');
    expect(s.images).toHaveLength(1);
    expect(calls.some((u) => u.includes('/download/attachments/'))).toBe(false);
  });
});
