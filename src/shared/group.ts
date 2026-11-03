// 好幾張單合成一個任務：同一條分支、同一段 AI 對話、一個 PR。
// 用「代表票」帶著全部成員：單號用主單（單號最小的那張），計畫表、審閱、分支大部分沿用一般的流程。
import { inChinese, t } from './i18n';
import type { JiraTicket } from './types';

const number = (key: string) => Number(key.match(/(\d+)$/)?.[1] ?? 0);

/** 合成一個任務：主單＝單號最小的那張；全部成員有同一張上層主單時，標題用它（例如「[M10] 內部測試問題修正」） */
export function groupTicket(tickets: JiraTicket[]): JiraTicket {
  if (tickets.length < 2) throw new Error(t('至少要兩張單才能合成一個任務'));
  const members = [...tickets].map((t) => ({ ...t, members: undefined })).sort((a, b) => number(a.key) - number(b.key));
  const primary = members[0];
  const parents = new Set(members.map((t) => t.parent?.key ?? ''));
  const common = parents.size === 1 && primary.parent ? primary.parent : null;
  return {
    ...primary,
    // 合成任務的標題會存起來、帶進 AI 對話和 PR，固定用中文
    summary: common ? common.summary : inChinese(() => t('{summary} 等 {n} 張', { summary: primary.summary, n: members.length })),
    members,
  };
}

/** 單號：合成任務列出全部（ALL-1, ALL-2），一般的單就是自己 */
export function ticketKeys(ticket: Pick<JiraTicket, 'key' | 'members'>): string {
  return ticket.members?.length ? ticket.members.map((m) => m.key).join(', ') : ticket.key;
}

/** 搜尋單號：不分大小寫、空白和橫線不算，只打數字也行（14597、all 14597 都找得到 ALL-14597）；合成任務裡任一張的單號也算 */
export function matchesKey(item: { ticketKey: string; members: { key: string }[] }, query: string): boolean {
  const plain = (text: string) => text.replace(/[\s-]+/g, '').toUpperCase();
  const q = plain(query);
  if (!q) return true;
  return [item.ticketKey, ...item.members.map((m) => m.key)].some((key) => plain(key).includes(q));
}
