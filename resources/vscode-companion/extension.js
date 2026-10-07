// FlowPilot 輔助外掛：收到 vscode://flowpilot.flowpilot-companion/attach?... 時，
// 在 VS Code 開一個終端機分頁，用 `codex resume <對話> --remote unix://` 接上那張單的 AI 對話。
// 同一個資料夾只保留一個分頁：換下一張單時，舊分頁會關掉換成新的。
const vscode = require('vscode');

const PREFIX = 'FlowPilot｜';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function attach({ thread, cwd, folder, ticket }) {
  if (!thread || !cwd || !folder) return;
  const folderPrefix = `${PREFIX}${folder}｜`;
  for (const terminal of vscode.window.terminals) {
    if (terminal.name.startsWith(folderPrefix)) terminal.dispose();
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const terminal = vscode.window.createTerminal({
    name: `${folderPrefix}${ticket || ''}`,
    cwd,
    shellPath: shell,
    // 用登入 shell 執行，才拿得到 codex 的 PATH
    shellArgs: ['-l', '-c', `codex resume ${shellQuote(thread)} --remote unix://`],
    iconPath: new vscode.ThemeIcon('rocket'),
  });
  terminal.show(false);
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const query = new URLSearchParams(uri.query);
        if (uri.path === '/attach') {
          attach({ thread: query.get('thread'), cwd: query.get('cwd'), folder: query.get('folder'), ticket: query.get('ticket') });
        }
      },
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
