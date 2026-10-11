// 聊天紀錄：把 Codex 對話裡的各種項目（你的訊息、AI 回覆、思考、指令、檔案改動、工具…）整理成畫面要顯示的格式。
import { ACCEPTANCE_NOTE } from '../shared/acceptance';
import type { ChatEntry } from '../shared/types';
import type { CodexRpc } from './codex/rpc';

const MAX_OUTPUT = 20_000;

function clip(text: string | null | undefined): string {
  if (!text) return '';
  return text.length > MAX_OUTPUT ? `…（前面省略）\n${text.slice(-MAX_OUTPUT)}` : text;
}

/** FlowPilot 送出的第一則訊息裡有技能內容，畫面上只顯示我們寫的那段文字 */
function userText(content: any[]): { text: string; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of content ?? []) {
    // 修改時 FlowPilot 附在後面的說明不顯示，只留你說的話
    if (part.type === 'text') texts.push(String(part.text ?? '').split(ACCEPTANCE_NOTE)[0].trimEnd());
    else if (part.type === 'skill') texts.push(`［技能：${part.name}］`);
    else if (part.type === 'localImage') images.push(part.path);
    else if (part.type === 'image' && part.url) images.push(part.url);
    else if (part.type === 'mention') texts.push(`@${part.name}`);
  }
  return { text: texts.join('\n'), images };
}

function toolText(item: any): string {
  const name = item.type === 'mcpToolCall' ? `${item.server}：${item.tool}` : `${item.namespace ? `${item.namespace}：` : ''}${item.tool}`;
  return name;
}

function toolOutput(item: any): string {
  if (item.error?.message) return `錯誤：${item.error.message}`;
  const parts = item.result?.content ?? item.contentItems ?? [];
  return clip(
    parts
      .map((c: any) => (typeof c?.text === 'string' ? c.text : c?.type === 'image' ? '［圖片］' : ''))
      .filter(Boolean)
      .join('\n'),
  );
}

/** 一個 Codex 項目 → 一則聊天紀錄；不需要顯示的回傳 null */
export function toEntry(item: any, at: number | null = null): ChatEntry | null {
  switch (item?.type) {
    case 'userMessage': {
      const { text, images } = userText(item.content);
      return { id: item.id, kind: 'user', text, images, at };
    }
    case 'agentMessage':
      return { id: item.id, kind: 'assistant', text: item.text ?? '', at };
    case 'reasoning': {
      const text = (item.summary ?? []).join('\n\n');
      return { id: item.id, kind: 'reasoning', text, at };
    }
    case 'plan':
      return { id: item.id, kind: 'plan', text: item.text ?? '', at };
    case 'commandExecution':
      return {
        id: item.id,
        kind: 'command',
        text: '',
        command: item.command ?? '',
        output: clip(item.aggregatedOutput),
        exitCode: item.exitCode ?? null,
        status: item.status,
        at,
      };
    case 'fileChange':
      return {
        id: item.id,
        kind: 'fileChange',
        text: '',
        status: item.status,
        files: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: clip(c.diff) })),
        at,
      };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { id: item.id, kind: 'tool', text: toolText(item), output: toolOutput(item), status: item.status, at };
    case 'webSearch':
      return { id: item.id, kind: 'search', text: item.query ?? '', at };
    case 'enteredReviewMode':
      return { id: item.id, kind: 'notice', text: '開始程式碼審查', at };
    case 'exitedReviewMode':
      return { id: item.id, kind: 'notice', text: '程式碼審查結束', at };
    case 'contextCompaction':
      return { id: item.id, kind: 'notice', text: '對話太長，AI 已經整理壓縮了前面的內容', at };
    default:
      return null;
  }
}

/** 完整的對話紀錄（舊到新） */
export async function loadHistory(codex: CodexRpc, threadId: string): Promise<ChatEntry[]> {
  await codex.start();
  const entries: ChatEntry[] = [];
  let cursor: string | null = null;
  const fetchPage = () => codex.request<{ data: { item: any; startedAtMs: number | null }[]; nextCursor: string | null }>('thread/items/list', { threadId, cursor, limit: 200, sortDirection: 'asc' });
  let page;
  try {
    page = await fetchPage();
  } catch {
    // 對話還沒載入（例如 FlowPilot 重新啟動後）：先接上再讀
    await codex.request('thread/resume', { threadId, excludeTurns: true });
    page = await fetchPage();
  }
  for (;;) {
    for (const entry of page.data) {
      const chat = toEntry(entry.item, entry.startedAtMs);
      if (chat) entries.push(chat);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    page = await fetchPage();
  }
  return entries;
}
