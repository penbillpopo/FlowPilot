// 需求變更：拿 Jira 上最新的內容跟上次確認過的快照比，找出需求相關的變化。
// 只比內容（標題、內文、留言、附件），狀態、指派人這類變動不算。比對完全不用 AI。
import type { RequirementChange, TicketSnapshot } from '../shared/types';

/** 逐行差異（最長共同子序列）；只回傳新增與刪除的行 */
export function lineDiff(before: string, after: string): { type: 'add' | 'del'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // 太長的內文用簡化比對，避免卡住
  if (a.length * b.length > 4_000_000) {
    const setA = new Set(a);
    const setB = new Set(b);
    return [...a.filter((l) => !setB.has(l)).map((text) => ({ type: 'del' as const, text })), ...b.filter((l) => !setA.has(l)).map((text) => ({ type: 'add' as const, text }))];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { type: 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out.filter((l) => l.text.trim() !== '');
}

/** 比對同一張單的兩份快照 */
function diffOne(before: TicketSnapshot, after: TicketSnapshot, label: string): RequirementChange[] {
  const changes: RequirementChange[] = [];
  const from = after.key;
  if (before.summary !== after.summary) {
    changes.push({ kind: 'summary', from, title: `${label}標題被修改`, lines: [{ type: 'del', text: before.summary }, { type: 'add', text: after.summary }] });
  }
  if (before.description !== after.description) {
    const lines = lineDiff(before.description, after.description);
    if (lines.length) changes.push({ kind: 'description', from, title: `${label}內文被修改`, lines });
  }
  const old = new Map(before.comments.map((c) => [c.id, c]));
  for (const comment of after.comments) {
    const previous = old.get(comment.id);
    if (!previous) changes.push({ kind: 'newComment', from, title: `${comment.author || '有人'}在${label}新增了一則留言`, text: comment.text });
    else if (previous.text !== comment.text) {
      changes.push({ kind: 'editedComment', from, title: `${comment.author || '有人'}修改了${label}的留言`, lines: lineDiff(previous.text, comment.text) });
    }
  }
  const oldFiles = new Set(before.attachments);
  const added = after.attachments.filter((f) => !oldFiles.has(f));
  if (added.length) changes.push({ kind: 'newAttachment', from, title: `${label}新增了 ${added.length} 個附件`, text: added.join('、') });
  return changes;
}

/**
 * 比對一張單（子任務＋主單）的快照。
 * 上次沒有快照的單（例如這個功能上線前就審閱過的）不算有變更，直接以這次為準。
 */
export function diffSnapshots(before: TicketSnapshot[] | undefined, after: TicketSnapshot[], subKey: string): RequirementChange[] {
  if (!before?.length) return [];
  const changes: RequirementChange[] = [];
  for (const snapshot of after) {
    const previous = before.find((s) => s.key === snapshot.key);
    if (previous) changes.push(...diffOne(previous, snapshot, snapshot.key === subKey ? '子任務' : '主單'));
  }
  return changes;
}

/**
 * 你按「更新需求」之後交給 AI 的訊息，AI 在對話裡回答：
 * - 沒有變更：只回「這個需求沒有變更」
 * - 有變更：(a) 變更了什麼 (b) 打算怎麼改；先不改檔案，等你確認
 * 沒有之前的快照時，附上目前的完整內容，請 AI 跟自己之前的理解比對。
 */
export function updateMessage(changes: RequirementChange[] | null, current: TicketSnapshot[]): string {
  const reply = [
    '請在對話中回覆：',
    '- 如果沒有變更：只回覆「這個需求沒有變更」。',
    '- 如果有變更：(a) 說明變更的內容是什麼；(b) 針對這個變更，你計劃怎麼修改（會影響哪些檔案、畫面、已經做好的部分）。',
    '先不要修改任何檔案，等我確認之後再開始。',
  ];
  if (changes && changes.length === 0) {
    return ['## 更新需求', '', '我發起了「更新需求」。FlowPilot 重新讀了 Jira，跟上次確認過的內容相比，沒有任何變更。', '請只回覆「這個需求沒有變更」。'].join('\n');
  }
  if (changes) {
    const parts = ['## 更新需求', '', '我發起了「更新需求」。FlowPilot 重新讀了 Jira，跟上次確認過的內容相比，有以下變更：', ''];
    for (const change of changes) {
      parts.push(`### ${change.title}（${change.from}）`);
      if (change.lines?.length) parts.push(...change.lines.map((l) => `${l.type === 'add' ? '+ ' : '- '}${l.text}`));
      if (change.text) parts.push(change.text);
      parts.push('');
    }
    return [...parts, ...reply].join('\n');
  }
  const parts = ['## 更新需求', '', '我發起了「更新需求」。這張單沒有之前的快照可以比對，以下是 Jira 上目前的內容，請跟你之前理解的需求比對，看看有沒有變更：', ''];
  for (const snapshot of current) {
    parts.push(`### ${snapshot.key}：${snapshot.summary}`, snapshot.description || '（沒有內文）');
    if (snapshot.comments.length) parts.push('留言：', ...snapshot.comments.map((c) => `- ${c.author}：${c.text}`));
    parts.push('');
  }
  return [...parts, ...reply].join('\n');
}
