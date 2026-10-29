// Git 改動面板（像 VS Code 的「原始碼控制」）：變更／暫存的變更、差異、暫存、取消暫存、捨棄、提交、推送。
import { t } from '../shared/i18n';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BranchCommits, CommitResult, GitFile, GitIdentity, GitState } from '../shared/types';
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
  if (full !== resolve(cwd) && !full.startsWith(resolve(cwd) + sep)) throw new Error(t('路徑不在資料夾裡：{path}', { path }));
  return full;
}

async function git(cwd: string, args: string[]) {
  const result = await runGit(cwd, args, 60_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || t('git {command} 失敗', { command: args[0] }));
  return result.stdout;
}

export async function gitState(cwd: string, baseBranch?: string): Promise<GitState> {
  // rebase 到一半（例如同步基底分支有衝突、AI 正在解）時 git 暫時不在分支上：當成還在原本那條分支，畫面才不會誤報「不在這張單的分支」
  const rebasing = ['rebase-merge', 'rebase-apply'].map((d) => join(cwd, '.git', d, 'head-name')).find((f) => existsSync(f));
  const branch = (await currentBranch(cwd)) || (rebasing ? readFileSync(rebasing, 'utf8').trim().replace(/^refs\/heads\//, '') : '');
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

/** 解析 --name-status -z：改名、複製的那一筆後面跟著舊路徑和新路徑，顯示新路徑 */
export function parseNameStatus(raw: string): GitFile[] {
  const files: GitFile[] = [];
  const parts = raw.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i][0];
    if (code === 'R' || code === 'C') {
      files.push({ code, path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ code, path: parts[i + 1] });
      i += 1;
    }
  }
  return files.filter((f) => f.path);
}

const SHA = /^[0-9a-f]{7,40}$/;

/** 基底分支的參照：先用遠端的（最新），本機沒抓過才用本機的 */
async function baseRef(cwd: string, base: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])).code === 0 ? `origin/${base}` : base;
}

/**
 * 這條分支比基底多出來的提交（不含合併提交），和整條分支合計改了哪些檔案。唯讀，不切換分支。
 * ref 是本機分支名稱，或本機沒有時的 origin/分支。
 */
export async function branchCommits(cwd: string, ref: string, branch: string, base: string): Promise<Omit<BranchCommits, 'where'>> {
  const from = await baseRef(cwd, base);
  const range = `${from}..${ref}`;
  const log = await git(cwd, ['log', '--no-merges', '-n', '50', '--format=%H%x1f%s%x1f%cI', range, '--']);
  const total = Number((await git(cwd, ['rev-list', '--no-merges', '--count', range, '--'])).trim()) || 0;
  // 還沒推送的：遠端分支沒有的提交；遠端還沒有這條分支就全部都還沒推送
  const hasRemote = await remoteBranchExists(cwd, branch);
  const unpushed = new Set(hasRemote ? (await git(cwd, ['rev-list', `refs/remotes/origin/${branch}..${ref}`, '--'])).split('\n').filter(Boolean) : []);
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, date] = line.split('\x1f');
    return { sha, subject, date, pushed: hasRemote && !unpushed.has(sha) };
  });
  const files = parseNameStatus(await git(cwd, ['diff', '--name-status', '-z', `${from}...${ref}`, '--']));
  return { base, commits, total, files };
}

/** 某個提交改了哪些檔案 */
export async function commitFiles(cwd: string, sha: string): Promise<GitFile[]> {
  if (!SHA.test(sha)) throw new Error(t('提交編號不對：{sha}', { sha }));
  return parseNameStatus(await git(cwd, ['show', '--format=', '--name-status', '-z', sha, '--']));
}

/** 某個檔案在某個提交改了什麼；sha 是 null 代表整條分支跟基底比 */
export async function commitDiff(cwd: string, ref: string, base: string, sha: string | null, path: string): Promise<string> {
  inside(cwd, path);
  if (sha === null) return git(cwd, ['diff', `${await baseRef(cwd, base)}...${ref}`, '--', path]);
  if (!SHA.test(sha)) throw new Error(t('提交編號不對：{sha}', { sha }));
  return git(cwd, ['show', '--format=', sha, '--', path]);
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

/** 測試時切 SIT／UAT 改到的檔案：不提交 */
export const isTestOnlyFile = (path: string) => /(^|\/)src\/environments\/environment[^/]*\.ts$/.test(path);

/**
 * 提交全部改動（給操作者用：不用管暫存）：
 * - 測試用的 environment.ts 不提交
 * - 專案的提交前檢查（例如 ng lint --fix）順手改到的無關檔案，提交後自動還原（它們提交前是乾淨的，還原就是回到原樣）
 */
export async function commitAll(cwd: string, message: string, identity?: GitIdentity): Promise<CommitResult & { restored: string[] }> {
  if (!message.trim()) throw new Error(t('請輸入提交訊息'));
  const before = await gitState(cwd);
  const files = [...before.staged, ...before.unstaged].map((f) => f.path);
  const toCommit = [...new Set(files.filter((p) => !isTestOnlyFile(p)))];
  if (toCommit.length === 0) throw new Error(t('沒有要提交的改動'));
  // 先把暫存區整理成「只有要提交的」：測試用的檔案如果被暫存過就拿出來
  const testOnlyStaged = before.staged.map((f) => f.path).filter(isTestOnlyFile);
  if (testOnlyStaged.length) await git(cwd, ['restore', '--staged', '--', ...testOnlyStaged]);
  await git(cwd, ['add', '-A', '--', ...toCommit]);
  const result = await commitStaged(cwd, message, identity);
  // 提交前檢查改到的無關檔案：自動還原
  for (const path of result.hookChanged) {
    await runGit(cwd, ['restore', '--staged', '--worktree', '--', path]);
  }
  return { ...result, restored: result.hookChanged };
}

/** 在資料夾裡用登入 shell 執行（專案的提交前檢查、推送的帳密都需要使用者的環境） */
export function loginShell(cwd: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(process.env.SHELL || '/bin/zsh', ['-l', '-c', command], { cwd, timeout: timeoutMs, env, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      const tail = output.split('\n').slice(-6).join('\n');
      // 超過時間被停掉：說清楚是逾時（以前直接把最後幾行輸出當錯誤，看起來像「全部通過」也是錯）
      if (error && (error as { killed?: boolean }).killed) reject(new Error(t('超過 {min} 分鐘還沒做完，FlowPilot 不等了', { min: Math.round(timeoutMs / 60_000) }) + (tail ? `\n${tail}` : '')));
      else if (error) reject(new Error(tail || error.message));
      else resolvePromise(output);
    });
  });
}

/** 提交暫存的變更，回傳提交編號 */
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * 提交暫存的變更；指定身分時只用在這一次，不改資料夾的設定。
 * 專案的提交前檢查（ng lint --fix 檢查整個專案）在電腦很忙時可能要十幾分鐘，最多等 30 分鐘。
 */
export async function commitStaged(cwd: string, message: string, identity?: GitIdentity, timeoutMs = 30 * 60_000): Promise<CommitResult> {
  if (!message.trim()) throw new Error(t('請輸入提交訊息'));
  const before = await gitState(cwd);
  if (before.staged.length === 0) throw new Error(t('沒有暫存的變更可以提交'));
  const touched = new Set([...before.staged, ...before.unstaged].map((f) => f.path));
  const dir = mkdtempSync(join(tmpdir(), 'flowpilot-commit-'));
  const file = join(dir, 'message.txt');
  writeFileSync(file, `${message.trim()}\n`);
  const headBefore = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  try {
    const who = identity ? `-c user.name=${shellQuote(identity.name)} -c user.email=${shellQuote(identity.email)} ` : '';
    await loginShell(cwd, `git ${who}commit -F '${file}'`, timeoutMs);
  } catch (error) {
    // 回報失敗，但其實提交了（實際發生過：等提交前檢查等到逾時，外層停掉了，git 自己跑完照樣提交，畫面卻顯示錯誤）：當成成功
    const headAfter = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!headAfter || headAfter === headBefore) throw error;
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
  if (!branch) throw new Error(t('目前不在任何分支上，不推送'));
  const quoted = `'${branch.replace(/'/g, `'\\''`)}'`;
  // rebase 過之後遠端的歷史跟本機不一樣，要強制推送；用 --force-with-lease，遠端被別人推了新東西時會拒絕，不會吃掉別人的提交
  const force = (await gitState(cwd)).needsForce ? '--force-with-lease ' : '';
  return loginShell(cwd, `git push ${force}-u origin ${quoted}`, 5 * 60_000);
}
