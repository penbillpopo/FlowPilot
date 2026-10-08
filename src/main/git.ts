// git 操作：只用 execFile 帶參數陣列，不經過 shell，分支名稱有特殊字元也不會被拆開。
import { execFile } from 'node:child_process';
import type { PlanBranch } from '../shared/types';
import type { FolderSetting } from './settings';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() || (error && !stderr ? error.message : '') });
    });
  });
}

/** 正在抓遠端的倉庫：同一個倉庫同時只抓一次，後來的請求等同一次的結果 */
const fetching = new Map<string, Promise<void>>();

/**
 * 抓遠端最新狀態（只更新遠端紀錄，不碰資料夾裡的檔案）。
 * 同一個倉庫同時抓兩次，git 會搶不到紀錄的鎖而失敗（unable to update local ref），
 * 所以同一個倉庫的請求合併成一次；萬一還是撞到別的程式在抓，等一下再試一次。
 */
export function fetchOrigin(cwd: string): Promise<void> {
  const running = fetching.get(cwd);
  if (running) return running;
  const task = (async () => {
    for (let attempt = 1; ; attempt++) {
      const result = await runGit(cwd, ['fetch', '--prune', 'origin'], 120_000);
      if (result.code === 0) return;
      const locked = /unable to update local ref|cannot lock ref|\.lock': File exists/i.test(result.stderr);
      if (locked && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw new Error(`抓遠端失敗（${cwd}）：${result.stderr.trim().split('\n').pop()}`);
    }
  })().finally(() => fetching.delete(cwd));
  fetching.set(cwd, task);
  return task;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await runGit(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0;
}

/**
 * 檢查分支是否已建立：名稱完全相同才算。
 * 每個專案的所有資料夾先抓一次遠端，再看各資料夾的本機分支與遠端分支。
 * 你在計畫表修改內容時不重新抓遠端（剛抓過），只重新比對。
 */
export async function checkExisting(branches: PlanBranch[], folders: FolderSetting[], options = { fetch: true }): Promise<PlanBranch[]> {
  const projects = [...new Set(branches.map((b) => b.project))];
  const projectFolders = new Map(projects.map((p) => [p, folders.filter((f) => f.project === p)]));
  for (const [project, list] of projectFolders) {
    if (list.length === 0) throw new Error(`設定檔裡沒有「${project}」的資料夾`);
  }
  if (options.fetch) await Promise.all([...projectFolders.values()].flat().map((f) => fetchOrigin(f.path)));

  return Promise.all(
    branches.map(async (branch) => {
      const list = projectFolders.get(branch.project)!;
      const existsIn: string[] = [];
      for (const folder of list) {
        if (await refExists(folder.path, `refs/heads/${branch.branch}`)) existsIn.push(folder.name);
      }
      // 同一個專案的資料夾都連到同一個遠端，看第一個就好
      if (await refExists(list[0].path, `refs/remotes/origin/${branch.branch}`)) existsIn.push('遠端');
      return { ...branch, existsIn };
    }),
  );
}

/** 資料夾目前所在的分支（不在任何分支上時回傳空字串） */
export async function currentBranch(cwd: string): Promise<string> {
  return (await runGit(cwd, ['branch', '--show-current'])).stdout.trim();
}

/** 未提交的修改（包含未追蹤的檔案）；空陣列代表乾淨 */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['status', '--porcelain']);
  if (result.code !== 0) throw new Error(`讀不到 git 狀態（${cwd}）：${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

export async function localBranchExists(cwd: string, branch: string): Promise<boolean> {
  return refExists(cwd, `refs/heads/${branch}`);
}

export async function remoteBranchExists(cwd: string, branch: string): Promise<boolean> {
  return refExists(cwd, `refs/remotes/origin/${branch}`);
}

/** 從遠端最新的基底分支建立新分支（不切換） */
export async function createBranch(cwd: string, branch: string, baseBranch: string): Promise<void> {
  const result = await runGit(cwd, ['branch', '--no-track', branch, `origin/${baseBranch}`]);
  if (result.code !== 0) throw new Error(`建立分支 ${branch} 失敗：${result.stderr.trim()}`);
}

export async function switchBranch(cwd: string, branch: string): Promise<void> {
  const result = await runGit(cwd, ['switch', branch]);
  if (result.code !== 0) throw new Error(`切換到 ${branch} 失敗：${result.stderr.trim()}`);
}

/** 某個檔案在目前分支的內容雜湊（用來判斷 package-lock.json 有沒有變） */
export async function fileHash(cwd: string, path: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', `HEAD:${path}`])).stdout.trim();
}

/** 本機分支跟遠端分支比：本機多幾個提交、遠端多幾個提交 */
export async function aheadBehind(cwd: string, branch: string): Promise<{ ahead: number; behind: number }> {
  const result = await runGit(cwd, ['rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/origin/${branch}`]);
  if (result.code !== 0) throw new Error(`比對 ${branch} 與遠端失敗：${result.stderr.trim()}`);
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

/** 目前分支比基底分支多了幾個提交 */
export async function commitsSinceBase(cwd: string, baseBranch: string): Promise<number> {
  const result = await runGit(cwd, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]);
  return result.code === 0 ? Number(result.stdout.trim()) : 0;
}

/** 只在遠端有的分支：建立追蹤遠端的本機分支並切換 */
export async function switchToRemoteBranch(cwd: string, branch: string): Promise<void> {
  const result = await runGit(cwd, ['switch', '-c', branch, '--track', `origin/${branch}`]);
  if (result.code !== 0) throw new Error(`從遠端切換到 ${branch} 失敗：${result.stderr.trim()}`);
}

/** 本機落後遠端、沒有自己的新提交時，快轉到遠端最新 */
export async function fastForward(cwd: string, branch: string): Promise<void> {
  const result = await runGit(cwd, ['merge', '--ff-only', `origin/${branch}`]);
  if (result.code !== 0) throw new Error(`快轉 ${branch} 到遠端最新失敗：${result.stderr.trim()}`);
}
