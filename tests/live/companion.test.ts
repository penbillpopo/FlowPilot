// 實測（LIVE=1 才跑）：打包並安裝 VS Code 輔助外掛
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import { VSCode } from '../../src/main/vscode';

it.runIf(process.env.LIVE)('安裝輔助外掛', { timeout: 120_000 }, async () => {
  const vscode = new VSCode(resolve('resources/vscode-companion'), mkdtempSync(join(tmpdir(), 'fp-')), async () => {});
  await vscode.ensureCompanion();
});
