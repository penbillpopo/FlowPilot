import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 你 Codex 設定裡會操作瀏覽器、電腦的工具，在 FlowPilot 的對話裡關掉（不改你的 ~/.codex/config.toml）：
 * - playwright：你原本的，AI 才不會用錯（測試要用 FlowPilot 的，有寫入防護）。
 * - node_repl（對話裡叫 cua_repl）、computer-use：ChatGPT 應用程式加的。它的說明寫「所有畫面操作都用 cua_repl」，
 *   實際發生過：按「看我的」，AI 去用它、回「Browser is not available」，根本沒呼叫共用瀏覽器，Chrome 也就沒跳出選分頁的頁面。
 *   它啟動也很慢（設定的等待上限 120 秒），審閱、翻譯這類對話也一併關掉。
 */
export function userBrowserToolsOff(configFile = join(homedir(), '.codex/config.toml')): Record<string, { enabled: false }> {
  let config = '';
  try {
    config = readFileSync(configFile, 'utf8');
  } catch {}
  const names = [...config.matchAll(/^\[mcp_servers\.("?)([\w-]+)\1\]/gm)].map((m) => m[2]);
  return Object.fromEntries(names.filter((n) => /^(playwright|node_repl|computer[-_]use)$/.test(n)).map((n) => [n, { enabled: false as const }]));
}
