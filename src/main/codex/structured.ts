// 用一段不留紀錄的臨時對話，請 Codex 依固定格式（JSON Schema）回答一個問題。
import type { SkillInfo } from '../../shared/types';
import type { CodexRpc, RpcMessage } from './rpc';

export interface StructuredRequest {
  prompt: string;
  schema: object;
  cwd: string;
  developerInstructions?: string;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

export async function askStructured<T>(rpc: CodexRpc, request: StructuredRequest): Promise<T> {
  await rpc.start();
  const { thread } = await rpc.request<{ thread: { id: string } }>('thread/start', {
    cwd: request.cwd,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions: request.developerInstructions ?? null,
    config: { model_reasoning_effort: request.effort ?? 'low' },
  });
  const threadId = thread.id;

  let lastMessage = '';
  let unsubscribe = () => {};
  const finished = new Promise<RpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI 判斷逾時')), request.timeoutMs ?? 180_000);
    unsubscribe = rpc.on((message) => {
      if (message.params?.threadId !== threadId) return;
      // 這段對話是唯讀、不准執行指令；萬一來要同意，一律拒絕
      if (message.id !== undefined && /requestApproval|execCommandApproval|applyPatchApproval/.test(message.method ?? '')) {
        rpc.reply(message.id, { decision: 'decline' });
      }
      if (message.method === 'item/completed' && message.params.item?.type === 'agentMessage') lastMessage = message.params.item.text ?? '';
      if (message.method === 'turn/completed') {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });

  try {
    await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: request.prompt, text_elements: [] }],
      outputSchema: request.schema,
    });
    const done = await finished;
    const status = done.params.turn?.status;
    if (status !== 'completed') throw new Error(`AI 判斷沒有完成（${done.params.turn?.error?.message ?? status}）`);
    try {
      return JSON.parse(lastMessage) as T;
    } catch {
      throw new Error('AI 回覆的格式不正確');
    }
  } finally {
    unsubscribe();
    rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
  }
}

/** 列出 Codex 認得的技能 */
export async function listSkills(rpc: CodexRpc, cwd: string): Promise<SkillInfo[]> {
  await rpc.start();
  const response = await rpc.request<{ data: { skills: { name: string; description: string; path: string; enabled: boolean }[] }[] }>(
    'skills/list',
    { cwds: [cwd] },
  );
  const seen = new Map<string, SkillInfo>();
  for (const entry of response.data) {
    for (const skill of entry.skills) {
      if (skill.enabled && !seen.has(skill.name)) seen.set(skill.name, { name: skill.name, description: skill.description, path: skill.path });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
