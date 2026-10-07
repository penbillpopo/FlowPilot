// AI 要執行的指令：哪些自動同意、哪些要你確認。
// 開發中的 AI 用「每個指令都先問」的模式，由這裡決定；只有危險的才真的轉給你。

const DANGEROUS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b/, reason: '推送到遠端' },
  { pattern: /\bgit\s+commit\b/, reason: '提交（提交由你在 FlowPilot 審查後按「提交」）' },
  { pattern: /\bgit\s+(switch|checkout)\s+(?!--\s)(-[bBc]\s+)?[^\s-]/, reason: '切換分支（FlowPilot 已經切好分支）' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: '強制還原所有修改' },
  { pattern: /\bgit\s+clean\b/, reason: '刪除未追蹤的檔案' },
  { pattern: /\bgit\s+branch\s+(-[dD]|--delete)\b/, reason: '刪除分支' },
  { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, reason: '丟掉所有修改' },
  { pattern: /\bgit\s+(rebase|merge|stash)\b/, reason: '改寫或搬動提交紀錄' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, reason: '強制刪除資料夾' },
  { pattern: /\b(az\s+repos\s+pr\s+create|gh\s+pr\s+create)\b/, reason: '開合併請求' },
];

export interface PolicyResult {
  ask: boolean;
  reason: string;
}

export function commandPolicy(command: string): PolicyResult {
  for (const { pattern, reason } of DANGEROUS) {
    if (pattern.test(command)) return { ask: true, reason };
  }
  return { ask: false, reason: '' };
}

const QUESTION_HINTS = /請確認|請回覆|請選擇|請提供|請問|是否|要不要|需要你|等你|等待你的|再繼續|which|should I|confirm/i;

/** 一輪結束時，最後的回覆看起來是在問你問題，還是已經做完了 */
export function looksLikeQuestion(message: string): boolean {
  const tail = message.trim().slice(-400);
  return /[?？]\s*$/.test(tail) || QUESTION_HINTS.test(tail);
}
