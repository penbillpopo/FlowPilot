import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkExisting } from '../src/main/git';
import type { PlanBranch } from '../src/shared/types';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

/** 一個遠端倉庫 + 兩個獨立複本（模擬 PlatformWeb 與 PlatformWeb-2） */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-git-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'master-8', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:master-8');
  git(seed, 'push', '-q', 'origin', 'HEAD:ban/m8/ALL-2'); // 只在遠端
  const a = join(root, 'a');
  const b = join(root, 'b');
  git(root, 'clone', '-q', remote, a);
  git(root, 'clone', '-q', remote, b);
  git(b, 'branch', 'ban/m8/ALL-3'); // 只在第二個資料夾
  git(seed, 'push', '-q', 'origin', 'HEAD:ban/m8/ALL-4'); // clone 之後才推上去：要抓遠端才看得到
  return [
    { name: 'A', path: a, project: 'PlatformWeb' },
    { name: 'B', path: b, project: 'PlatformWeb' },
  ];
}

function branch(name: string): PlanBranch {
  return { ticketKey: 'X', project: 'PlatformWeb', merchant: 8, role: 'single', branch: name, baseBranch: 'master-8', existsIn: [] };
}

describe('分支是否已建立', () => {
  it('先抓遠端，再看所有資料夾與遠端；名稱完全相同才算', async () => {
    const folders = setup();
    const result = await checkExisting(
      [branch('ban/m8/ALL-1'), branch('ban/m8/ALL-2'), branch('ban/m8/ALL-3'), branch('ban/m8/ALL-4'), branch('ban/m8/ALL-2-2')],
      folders,
    );
    expect(result.map((b) => [b.branch, b.existsIn])).toEqual([
      ['ban/m8/ALL-1', []],
      ['ban/m8/ALL-2', ['遠端']],
      ['ban/m8/ALL-3', ['B']],
      ['ban/m8/ALL-4', ['遠端']],
      ['ban/m8/ALL-2-2', []],
    ]);
  });
});

describe('準備資料夾', () => {
  it('從遠端基底分支建立並切換，乾淨檢查包含未追蹤檔案', async () => {
    const { createBranch, currentBranch, dirtyFiles, localBranchExists, switchBranch } = await import('../src/main/git');
    const [folder] = setup();
    expect(await dirtyFiles(folder.path)).toEqual([]);
    await createBranch(folder.path, 'ban/m8/ALL-9', 'master-8');
    expect(await localBranchExists(folder.path, 'ban/m8/ALL-9')).toBe(true);
    await switchBranch(folder.path, 'ban/m8/ALL-9');
    expect(await currentBranch(folder.path)).toBe('ban/m8/ALL-9');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(folder.path, 'new.txt'), 'x');
    expect(await dirtyFiles(folder.path)).toEqual(['new.txt']);
    await expect(createBranch(folder.path, 'ban/m8/ALL-9', 'master-8')).rejects.toThrow('建立分支');
  });
});
