// 好幾張單合成一個任務：同一條分支、同一段 AI 對話、一個 PR。
// 用「代表票」帶著全部成員：單號用主單（單號最小的那張），計畫表、審閱、分支大部分沿用一般的流程。
import type { JiraTicket } from './types';

const number = (key: string) => Number(key.match(/(\d+)$/)?.[1] ?? 0);

/** 合成一個任務：主單＝單號最小的那張；全部成員有同一張上層主單時，標題用它（例如「[M10] 內部測試問題修正」） */
export function groupTicket(tickets: JiraTicket[]): JiraTicket {
  if (tickets.length < 2) throw new Error('至少要兩張單才能合成一個任務');
  const members = [...tickets].map((t) => ({ ...t, members: undefined })).sort((a, b) => number(a.key) - number(b.key));
  const primary = members[0];
  const parents = new Set(members.map((t) => t.parent?.key ?? ''));
  const common = parents.size === 1 && primary.parent ? primary.parent : null;
  return {
    ...primary,
    summary: common ? common.summary : `${primary.summary} 等 ${members.length} 張`,
    members,
  };
}

/** 單號：合成任務列出全部（ALL-1, ALL-2），一般的單就是自己 */
export function ticketKeys(ticket: Pick<JiraTicket, 'key' | 'members'>): string {
  return ticket.members?.length ? ticket.members.map((m) => m.key).join(', ') : ticket.key;
}
