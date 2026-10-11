// Git 改動面板（像 VS Code 的「原始碼控制」）：變更／暫存的變更、差異、暫存、取消暫存、捨棄、提交、推送。
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CommitResult, GitFile, GitIdentity, GitState } from '../shared/types';
import { currentBranch, remoteBranchExists, runGit } from './git';

/** 解析 git status --porcelain=v1 -z：X 是暫存區、Y 是工作區 */
export function parseStatus(raw: string): { staged: GitFile[]; unstaged: GitFile[] } {
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    // 改名的下一段是原本的路徑，跳過
    if (x === 'R' || x === 'C') i++;
    if (x === '?' && y === '?') {
      unstaged.push({ path, code: 'U' });
      continue;
    }
    if (x !== ' ') staged.push({ path, code: x });
    if (y !== ' ') unstaged.push({ path, code: y });
  }
  return { staged, unstaged };
}

/** 路徑一定要在資料夾裡面，避免 ../ 之類的路徑碰到資料夾外的檔案 */
function inside(cwd: string, path: string): string {
  const full = resolve(cwd, path);
  if (full !== resolve(cwd) && !full.startsWith(resolve(cwd) + sep)) throw new Error(`路徑不在資料夾裡：${path}`);
  return full;
}

async function git(cwd: string, args: string[]) {
  const result = await runGit(cwd, args, 60_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} 失敗`);
  return result.stdout;
}

export async function gitState(cwd: string, baseBranch?: string): Promise<GitState> {
  const branch = await currentBranch(cwd);
  const { staged, unstaged } = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const hasRemote = branch ? await remoteBranchExists(cwd, branch) : false;
  let unpushed: number | null = null;
  if (hasRemote) unpushed = Number((await git(cwd, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`])).trim());
  const ahead = baseBranch ? Number((await runGit(cwd, ['rev-list', '--count', `origin/${baseBranch}..HEAD`])).stdout.trim() || 0) : 0;
  // 資料夾目前設定的提交身分（預設用這個）
  const identity = { name: (await runGit(cwd, ['config', 'user.name'])).stdout.trim(), email: (await runGit(cwd, ['config', 'user.email'])).stdout.trim() };
  // 遠端有本機沒有的提交（通常是 rebase 過）：推送要強制
  const needsForce = hasRemote ? Number((await runGit(cwd, ['rev-list', '--count', `HEAD..refs/remotes/origin/${branch}`])).stdout.trim() || 0) > 0 : false;
  return { branch, staged, unstaged, unpushed, hasRemote, ahead, identity, identities: [], needsForce };
}

/** 某個檔案的差異；新檔案（未追蹤）顯示整個檔案都是新增 */
export async function fileDiff(cwd: string, path: string, staged: boolean): Promise<string> {
  inside(cwd, path);
  if (!staged) {
    const tracked = (await runGit(cwd, ['ls-files', '--error-unmatch', '--', path])).code === 0;
    if (!tracked) return (await runGit(cwd, ['diff', '--no-index', '--', '/dev/null', path])).stdout;
  }
  return git(cwd, ['diff', ...(staged ? ['--cached'] : []), '--', path]);
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  paths.forEach((p) => inside(cwd, p));
  await git(cwd, ['add', '-A', '--', ...paths]);
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  paths.forEach((p) => inside(cwd, p));
  await git(cwd, ['restore', '--staged', '--', ...paths]);
}

/** 捨棄工作區的修改：已追蹤的還原，新檔案直接刪掉（畫面上一定先確認） */
export async function discard(cwd: string, paths: string[]): Promise<void> {
  const { unstaged } = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  for (const path of paths) {
    const full = inside(cwd, path);
    const file = unstaged.find((f) => f.path === path);
    if (!file) continue;
    if (file.code === 'U') rmSync(full, { force: true });
    else await git(cwd, ['restore', '--worktree', '--', path]);
  }
}

/** 在資料夾裡用登入 shell 執行（專案的提交前檢查、推送的帳密都需要使用者的環境） */
export function loginShell(cwd: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(process.env.SHELL || '/bin/zsh', ['-l', '-c', command], { cwd, timeout: timeoutMs, env, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (error) reject(new Error(output.split('\n').slice(-6).join('\n') || error.message));
      else resolvePromise(output);
    });
  });
}

/** 提交暫存的變更，回傳提交編號 */
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** 提交暫存的變更；指定身分時只用在這一次，不改資料夾的設定 */
export async function commitStaged(cwd: string, message: string, identity?: GitIdentity): Promise<CommitResult> {
  if (!message.trim()) throw new Error('請輸入提交訊息');
  const before = await gitState(cwd);
  if (before.staged.length === 0) throw new Error('沒有暫存的變更可以提交');
  const touched = new Set([...before.staged, ...before.unstaged].map((f) => f.path));
  const dir = mkdtempSync(join(tmpdir(), 'flowpilot-commit-'));
  const file = join(dir, 'message.txt');
  writeFileSync(file, `${message.trim()}\n`);
  try {
    const who = identity ? `-c user.name=${shellQuote(identity.name)} -c user.email=${shellQuote(identity.email)} ` : '';
    await loginShell(cwd, `git ${who}commit -F '${file}'`, 10 * 60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = await gitState(cwd);
  return {
    sha: (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim(),
    // 提交前本來沒動、提交完卻變了的檔案：專案的提交前檢查（例如 ng lint --fix）順手改的
    hookChanged: [...after.staged, ...after.unstaged].map((f) => f.path).filter((p) => !touched.has(p)),
  };
}

/** 推送目前分支（只有你按「推送」才會執行） */
export async function pushBranch(cwd: string): Promise<string> {
  const branch = await currentBranch(cwd);
  if (!branch) throw new Error('目前不在任何分支上，不推送');
  const quoted = `'${branch.replace(/'/g, `'\\''`)}'`;
  // rebase 過之後遠端的歷史跟本機不一樣，要強制推送；用 --force-with-lease，遠端被別人推了新東西時會拒絕，不會吃掉別人的提交
  const force = (await gitState(cwd)).needsForce ? '--force-with-lease ' : '';
  return loginShell(cwd, `git push ${force}-u origin ${quoted}`, 5 * 60_000);
}
