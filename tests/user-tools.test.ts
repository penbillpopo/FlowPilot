import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userBrowserToolsOff } from '../src/main/codex/user-tools';

describe('FlowPilot 的對話裡關掉你設定裡會搶走瀏覽器的工具', () => {
  it('關掉 playwright、node_repl（cua_repl）、computer-use，其他的不動', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'codex-')), 'config.toml');
    writeFileSync(file, [
      '[mcp_servers.jira]', 'command = "x"',
      '[mcp_servers.playwright]', '[mcp_servers.playwright.tools.browser_tabs]',
      '[mcp_servers.node_repl]', '[mcp_servers.node_repl.env]',
      '[mcp_servers.computer-use]',
      '[mcp_servers.figma]',
    ].join('\n'));
    expect(userBrowserToolsOff(file)).toEqual({ playwright: { enabled: false }, node_repl: { enabled: false }, 'computer-use': { enabled: false } });
    expect(userBrowserToolsOff(join(tmpdir(), '不存在.toml'))).toEqual({});
  });
});
