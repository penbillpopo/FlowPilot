import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, commitStaged, discard, fileDiff, gitState, parseStatus, pushBranch, stage, unstage } from '../src/main/gitpanel';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-panel-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const dir = join(root, 'work');
  git(root, 'clone', '-q', remote, dir);
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  writeFileSync(join(dir, 'b.ts'), 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'switch', '-q', '-c', 'ban/ALL-1');
  return dir;
}

describe('Git 改動面板', () => {
  it('解析狀態：暫存、未暫存、新檔案、改名', () => {
    expect(parseStatus('M  a.ts\0 M b.ts\0MM c.ts\0?? new.ts\0R  to.ts\0from.ts\0')).toEqual({
      staged: [{ path: 'a.ts', code: 'M' }, { path: 'c.ts', code: 'M' }, { path: 'to.ts', code: 'R' }],
      unstaged: [{ path: 'b.ts', code: 'M' }, { path: 'c.ts', code: 'M' }, { path: 'new.ts', code: 'U' }],
    });
  });

  it('暫存、取消暫存、看差異、捨棄、提交、推送', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    writeFileSync(join(dir, 'new.ts'), 'n\n');
    expect(await gitState(dir)).toMatchObject({
      branch: 'ban/ALL-1', staged: [], unstaged: [{ path: 'a.ts', code: 'M' }, { path: 'new.ts', code: 'U' }], hasRemote: false, unpushed: null,
    });
    expect(await fileDiff(dir, 'a.ts', false)).toContain('+a2');
    expect(await fileDiff(dir, 'new.ts', false)).toContain('+n');

    await stage(dir, ['a.ts']);
    expect((await gitState(dir)).staged).toEqual([{ path: 'a.ts', code: 'M' }]);
    expect(await fileDiff(dir, 'a.ts', true)).toContain('+a2');
    await unstage(dir, ['a.ts']);
    expect((await gitState(dir)).staged).toEqual([]);

    await discard(dir, ['new.ts', 'a.ts']);
    expect(existsSync(join(dir, 'new.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n');

    writeFileSync(join(dir, 'b.ts'), 'b2\n');
    await stage(dir, ['b.ts']);
    await expect(commitStaged(dir, '  ')).rejects.toThrow('提交訊息');
    const { sha, hookChanged } = await commitStaged(dir, 'feat(ALL-1) change b');
    expect(hookChanged).toEqual([]);
    expect(git(dir, 'log', '-1', '--format=%h %s').trim()).toBe(`${sha} feat(ALL-1) change b`);
    await expect(commitStaged(dir, 'x')).rejects.toThrow('沒有暫存的變更');

    await pushBranch(dir);
    expect(await gitState(dir)).toMatchObject({ hasRemote: true, unpushed: 0 });
    writeFileSync(join(dir, 'b.ts'), 'b3\n');
    await stage(dir, ['b.ts']);
    await commitStaged(dir, 'feat(ALL-1) more');
    expect((await gitState(dir)).unpushed).toBe(1);
    expect((await gitState(dir, 'main')).ahead).toBe(2); // 比基底多 2 個提交
  });

  it('資料夾外的路徑一律拒絕', async () => {
    const dir = repo();
    await expect(stage(dir, ['../outside.ts'])).rejects.toThrow('路徑不在資料夾裡');
    await expect(discard(dir, ['../../etc/passwd'])).rejects.toThrow('路徑不在資料夾裡');
  });

  it('提交身分：預設用資料夾設定的；指定身分只用在這一次，不改資料夾設定', async () => {
    const dir = repo();
    expect((await gitState(dir)).identity).toEqual({ name: 't', email: 't@t' });
    writeFileSync(join(dir, 'a.ts'), 'a2\n');
    await stage(dir, ['a.ts']);
    await commitStaged(dir, "feat(ALL-1) it's mine", { name: "o'neil", email: 'me@example.com' });
    expect(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s').trim()).toBe("o'neil <me@example.com>|o'neil <me@example.com>|feat(ALL-1) it's mine");
    expect(git(dir, 'config', 'user.email').trim()).toBe('t@t');
    writeFileSync(join(dir, 'b.ts'), 'b2\n');
    await stage(dir, ['b.ts']);
    await commitStaged(dir, 'feat(ALL-1) default');
    expect(git(dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('t <t@t>');
  });

  it('提交前檢查順手改了別的檔案：回報出來（這些檔案沒被提交，留在資料夾裡）', async () => {
    const dir = repo();
    // 模擬專案的 ng lint --fix：提交前整理了一個這次沒動的檔案
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho "// 格式整理" >> a.ts\n');
    chmodSync(join(dir, '.git/hooks/pre-commit'), 0o755);
    writeFileSync(join(dir, 'b.ts'), 'b2\n');
    await stage(dir, ['b.ts']);
    const { hookChanged } = await commitStaged(dir, 'feat(ALL-1) change b');
    expect(hookChanged).toEqual(['a.ts']);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('b.ts');
  });

  it('提交全部（操作者用）：environment.ts 不提交；提交前檢查改到的無關檔案自動還原', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'src/environments'), { recursive: true });
    writeFileSync(join(dir, 'src/environments/environment.ts'), 'sit\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'env');
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho "// 格式整理" >> a.ts\n');
    chmodSync(join(dir, '.git/hooks/pre-commit'), 0o755);
    writeFileSync(join(dir, 'b.ts'), 'b2\n');
    writeFileSync(join(dir, 'new.ts'), 'new\n');
    writeFileSync(join(dir, 'src/environments/environment.ts'), 'uat\n'); // 測試時切到 UAT
    const result = await commitAll(dir, 'feat(ALL-1) change');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['b.ts', 'new.ts']);
    expect(result.restored).toEqual(['a.ts']);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n'); // 回到原樣
    expect(git(dir, 'status', '--porcelain').trim()).toBe('M src/environments/environment.ts'); // 只剩測試用的
    await expect(commitAll(dir, 'x')).rejects.toThrow('沒有要提交的改動');
  });
});
