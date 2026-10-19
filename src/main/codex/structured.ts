// 請 Codex 依固定格式（JSON Schema）回答：可以是不留紀錄的臨時對話，也可以保留對話之後接著問。
import type { SkillInfo } from '../../shared/types';
import type { CodexRpc, RpcMessage } from './rpc';
import { userBrowserToolsOff } from './user-tools';
import { getLang, t } from '../../shared/i18n';

export interface StructuredRequest {
  prompt: string;
  schema: object;
  cwd: string;
  developerInstructions?: string;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /** 保留對話（之後可以用 threadId 接著問）；預設不保留 */
  keep?: boolean;
  /** 接著這段對話問（不用 cwd 等開新對話的參數） */
  threadId?: string;
  /** 一起給 AI 看的圖片（本機路徑） */
  images?: string[];
  /** 不管介面語言（例如翻譯：要照指定的語言寫） */
  keepLanguage?: boolean;
  /** 額外的對話設定（例如試登一次要帶上瀏覽器工具） */
  config?: Record<string, unknown>;
}

/**
 * 請 Codex 依固定格式（JSON Schema）回答。對話是唯讀的：可以讀檔、查程式碼，不能改東西。
 * 回傳答案與對話編號（保留的對話之後可以接著問）。
 */
export async function runStructured<T>(rpc: CodexRpc, request: StructuredRequest): Promise<{ result: T; threadId: string }> {
  await rpc.start();
  let threadId = request.threadId;
  const skills = await skillsOff(rpc, request.cwd);
  if (threadId) {
    // 接著問：對話可能還沒載入（例如 FlowPilot 重新啟動過）
    await rpc.request('thread/resume', { threadId, excludeTurns: true, config: { skills } }).catch(() => {});
  } else {
    const { thread } = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: request.cwd,
      ephemeral: !request.keep,
      // 不用 never：never 會把 MCP 工具（看 Figma、試登的瀏覽器）直接拒絕。
      // on-request 下唯讀環境裡的指令照樣直接跑；要提升權限的指令由下面一律拒絕，工具確認由下面自動同意
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      // 介面是英文：審閱、討論、試登這類給人看的結果請 AI 用英文寫
      developerInstructions:
        [request.developerInstructions, getLang() === 'en' && !request.keepLanguage ? '所有給人看的文字（說明、問題、建議、結論）都用英文（English）寫；格式說明、AGENTS.md 或技能裡如果寫「用繁體中文」，以這一句為準。' : null].filter(Boolean).join('\n\n') || null,
      config: { model_reasoning_effort: request.effort ?? 'low', features: { computer_use: false, browser_use: false, browser_use_external: false }, skills, ...request.config, mcp_servers: { ...userBrowserToolsOff(), ...(request.config?.mcp_servers as object | undefined) } },
    });
    threadId = thread.id;
  }
  const id = threadId;

  let lastMessage = '';
  let unsubscribe = () => {};
  const finished = new Promise<RpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('AI 逾時'))), request.timeoutMs ?? 180_000);
    unsubscribe = rpc.on((message) => {
      if (message.params?.threadId !== id) return;
      // 這段對話是唯讀的；萬一來要同意，一律拒絕
      if (message.id !== undefined && /requestApproval|execCommandApproval|applyPatchApproval/.test(message.method ?? '')) {
        rpc.reply(message.id, { decision: 'decline' });
      }
      // MCP 工具（例如審閱時看 Figma 設計稿）要確認的：不需要填資料的直接同意，要填資料或開網址的拒絕
      if (message.id !== undefined && message.method === 'mcpServer/elicitation/request') {
        const fields = Object.keys(message.params?.requestedSchema?.properties ?? {});
        rpc.reply(message.id, message.params?.mode !== 'url' && fields.length === 0 ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null });
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
      threadId: id,
      input: [{ type: 'text', text: request.prompt, text_elements: [] }, ...(request.images ?? []).map((path) => ({ type: 'localImage', path }))],
      outputSchema: request.schema,
    });
    const done = await finished;
    const status = done.params.turn?.status;
    if (status !== 'completed') throw new Error(t('AI 沒有完成（{reason}）', { reason: String(done.params.turn?.error?.message ?? status) }));
    try {
      return { result: JSON.parse(lastMessage) as T, threadId: id };
    } catch {
      throw new Error(t('AI 回覆的格式不正確'));
    }
  } finally {
    unsubscribe();
    if (!request.keep && !request.threadId) rpc.request('thread/unsubscribe', { threadId: id }).catch(() => {});
  }
}

/**
 * 審閱、判斷這類對話把所有技能關掉（只在這段對話生效，不改 ~/.codex/config.toml）。
 * 為什麼：Codex 會把所有技能的說明放進每段對話，審閱 Jira 單時 AI 自己去套用了 jira-frontend-analysis，
 * 照那個技能的規則停下來要 Jira 網址，回了不相干的內容（實際發生過）。
 */
let skillsCache: { at: number; paths: string[] } | null = null;
async function skillsOff(rpc: CodexRpc, cwd: string): Promise<{ config: { path: string; enabled: false }[] }> {
  if (!skillsCache || Date.now() - skillsCache.at > 10 * 60_000) {
    const paths = await listSkills(rpc, cwd).then((list) => list.map((s) => s.path)).catch(() => skillsCache?.paths ?? []);
    skillsCache = { at: Date.now(), paths };
  }
  return { config: skillsCache.paths.map((path) => ({ path, enabled: false as const })) };
}

/** 問一次就結束（不保留對話） */
export async function askStructured<T>(rpc: CodexRpc, request: StructuredRequest): Promise<T> {
  return (await runStructured<T>(rpc, request)).result;
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
