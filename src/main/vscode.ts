// VS Code：一個工作區包含四個固定資料夾；每個資料夾一個終端機分頁，接上那張單的 Codex 對話。
// 開分頁靠 FlowPilot 輔助外掛（resources/vscode-companion），第一次使用時自動打包安裝。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FolderSetting } from './settings';

const CODE_CANDIDATES = ['/opt/homebrew/bin/code', '/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'];
const COMPANION_ID = 'flowpilot.flowpilot-companion';

function run(file: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // code 指令本身也是 Electron，帶著這個變數會被當成 Node 執行
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeoutMs ?? 120_000, cwd: options.cwd, env }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString().trim() || error.message));
      else resolve(stdout.toString());
    });
  });
}

export class VSCode {
  private companionReady: Promise<void> | null = null;
  private workspaceOpened = false;

  constructor(
    private readonly companionSource: string,
    private readonly dataDir: string,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {}

  private codeCli(): string {
    const found = CODE_CANDIDATES.find((p) => existsSync(p));
    if (!found) throw new Error('找不到 VS Code 的 code 指令');
    return found;
  }

  private companionVersion(): string {
    return JSON.parse(readFileSync(join(this.companionSource, 'package.json'), 'utf8')).version;
  }

  /** 確認輔助外掛已安裝且是最新版，沒有就打包成 .vsix 安裝 */
  ensureCompanion(): Promise<void> {
    this.companionReady ??= (async () => {
      const code = this.codeCli();
      const version = this.companionVersion();
      const installed = await run(code, ['--list-extensions', '--show-versions']);
      if (installed.split('\n').includes(`${COMPANION_ID}@${version}`)) return;
      const work = mkdtempSync(join(tmpdir(), 'flowpilot-vsix-'));
      try {
        cpSync(this.companionSource, join(work, 'extension'), { recursive: true });
        writeFileSync(
          join(work, '[Content_Types].xml'),
          '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>' +
            '<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>',
        );
        writeFileSync(
          join(work, 'extension.vsixmanifest'),
          `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="flowpilot-companion" Version="${version}" Publisher="flowpilot" />
    <DisplayName>FlowPilot Companion</DisplayName>
    <Description xml:space="preserve">FlowPilot</Description>
    <Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`,
        );
        const vsix = join(work, 'flowpilot-companion.vsix');
        await run('/usr/bin/zip', ['-r', '-q', vsix, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: work });
        await run(code, ['--install-extension', vsix, '--force']);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    })().catch((error) => {
      this.companionReady = null;
      throw error;
    });
    return this.companionReady;
  }

  /** 工作區檔：四個固定資料夾 */
  workspaceFile(folders: FolderSetting[]): string {
    mkdirSync(this.dataDir, { recursive: true });
    const file = join(this.dataDir, 'FlowPilot.code-workspace');
    const content = JSON.stringify({ folders: folders.map((f) => ({ name: f.name, path: f.path })), settings: {} }, null, 2);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content);
    return file;
  }

  async openWorkspace(folders: FolderSetting[]): Promise<void> {
    await run(this.codeCli(), [this.workspaceFile(folders)]);
    if (!this.workspaceOpened) {
      this.workspaceOpened = true;
      // 第一次打開時等視窗載入完，外掛才收得到通知
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  /** 在 VS Code 開（或換掉）這個資料夾的終端機分頁，接上那張單的 AI 對話 */
  async attach(folders: FolderSetting[], item: { threadId: string; folder: string; ticketKey: string }): Promise<void> {
    const folder = folders.find((f) => f.name === item.folder);
    if (!folder) throw new Error(`設定檔裡沒有資料夾「${item.folder}」`);
    await this.ensureCompanion();
    await this.openWorkspace(folders);
    const query = new URLSearchParams({ thread: item.threadId, cwd: folder.path, folder: folder.name, ticket: item.ticketKey });
    await this.openUrl(`vscode://${COMPANION_ID}/attach?${query}`);
  }
}
