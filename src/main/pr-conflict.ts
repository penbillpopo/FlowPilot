// PR 跟目標分支有衝突時，一鍵解衝突重發：
// 1. 從最新的目標分支開一條新分支（原分支名-目標分支名，例如 ban/ALL-1-dev）；這條分支之前就開過的話接著用它
// 2. 把開發分支合併進去，有衝突交給 AI 解（AI 沒把握就停下來，不硬合）
// 3. 推送新分支、用它發新的 PR（名稱、說明、審核人沿用原本的）
// 4. 新 PR 發成功才放棄舊的（中途失敗時舊 PR 還在，不會兩個都沒有）
// 在 FlowPilot 的暫時資料夾（git worktree）做，不動任何專案資料夾目前的分支和改動；開發分支、遠端分支都不刪。
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { t, zhOnly } from '../shared/i18n';
import type { PrRecord } from '../shared/types';
import type { PrDetail } from './azure';
import { fetchOrigin, runGit } from './git';
import { loginShell } from './gitpanel';

/** 新分支的名稱：原分支名加上目標分支名（斜線換成橫線），例如 ban/ALL-1 發到 version/0.0.1 → ban/ALL-1-version-0.0.1 */
export function conflictBranchName(branch: string, target: string): string {
  return `${branch}-${target.replace(/\//g, '-')}`;
}

export interface AiMergeResult {
  /** 全部衝突都有把握地合好了 */
  resolved: boolean;
  /** 每個檔案怎麼合的 */
  files: { file: string; how: string }[];
  /** 沒把握的原因 */
  reason: string;
}

export interface ConflictDeps {
  /** 專案的資料夾（只用它的 git 倉庫開暫時資料夾，不切換它的分支） */
  repoDir: string;
  /** 暫時資料夾放這裡 */
  workDir: string;
  azure: {
    prDetail(id: number): Promise<PrDetail>;
    branchExists(branch: string): Promise<boolean>;
    createPr(input: { source: string; target: string; title: string; description: string; reviewerIds: string[] }): Promise<{ id: number; url: string }>;
    abandonPr(id: number): Promise<void>;
    getPr(id: number): Promise<PrRecord>;
    activePrs(branch: string): Promise<PrRecord[]>;
  };
  /** 請 AI 在暫時資料夾解衝突（只改檔案，不 add、不提交） */
  resolveWithAi(cwd: string, prompt: string): Promise<AiMergeResult>;
  progress(text: string): void;
  log(message: string): void;
}

const MARKERS = /^(<{7}|>{7})( |$)/m;

/**
 * 解衝突用的分支：原分支名-目標分支名。有衝突的 PR 本身就是從這種分支發的（之前解過一次，目標分支又往前走了），
 * 就沿用它，不再加一層（不會變成 ban/ALL-1-master-master）。
 */
export function conflictBranchFor(source: string, target: string): string {
  const suffix = `-${target.replace(/\//g, '-')}`;
  return source.endsWith(suffix) ? source : conflictBranchName(source, target);
}

export interface ConflictOutcome {
  /** 解完以後要看的 PR */
  pr: PrRecord;
  /**
   * - new：開了新分支、發了新 PR，舊的放棄
   * - updated：分支之前就有、而且那條分支已經有發到同一個目標的 PR：把新內容推上去（那個 PR 自動更新），有衝突的放棄
   * - self：有衝突的 PR 就是從解衝突分支發的：把最新的目標分支合進去推上去，PR 就地更新，不用放棄
   */
  mode: 'new' | 'updated' | 'self';
}

/**
 * 解衝突重發。
 * 解衝突用的分支已經存在（之前處理過）時不停下來：接著用那條分支，把最新的目標分支和開發分支的新改動合進去，
 * 一般推送（不強制推送、不刪分支）；那條分支已經有發到同一個目標的 PR 就讓它更新，不重複發。
 */
export async function resolvePrConflict(deps: ConflictDeps, prId: number, ticket: { key: string; summary: string }): Promise<ConflictOutcome> {
  deps.progress(t('讀取 PR'));
  const old = await deps.azure.prDetail(prId);
  if (old.status !== 'active') throw new Error(t('這個 PR 已經不是審核中，不用處理'));
  if (!old.source || !old.target) throw new Error(t('讀不到這個 PR 的來源或目標分支'));
  const branch = conflictBranchFor(old.source, old.target);
  const self = branch === old.source;

  deps.progress(t('抓最新的 {target}', { target: old.target }));
  await fetchOrigin(deps.repoDir);
  const existing = await deps.azure.branchExists(branch);
  if (self && !existing) throw new Error(t('遠端找不到 {branch}', { branch }));
  const dir = join(deps.workDir, branch.replace(/[^\w.-]+/g, '_'));
  rmSync(dir, { recursive: true, force: true });
  await runGit(deps.repoDir, ['worktree', 'prune']);
  mkdirSync(deps.workDir, { recursive: true });
  // 不在本機建分支（本機可能已經有同名的舊分支）：暫時資料夾不掛分支，做完直接推到遠端的那條分支
  const start = existing ? `origin/${branch}` : `origin/${old.target}`;
  const added = await runGit(deps.repoDir, ['worktree', 'add', '--detach', dir, start]);
  if (added.code !== 0) throw new Error(t('開暫時資料夾失敗：{error}', { error: added.stderr.trim().split('\n').slice(-2).join(' ') }));
  // 提交前檢查（lint）要用專案的套件：借專案資料夾的 node_modules，不另外安裝
  const modules = join(deps.repoDir, 'node_modules');
  if (existsSync(modules) && !existsSync(join(dir, 'node_modules'))) symlinkSync(modules, join(dir, 'node_modules'));

  /** 把一條遠端分支合併進暫時資料夾；有衝突交給 AI */
  const mergeIn = async (from: string) => {
    deps.progress(t('把 {source} 合併進 {branch}', { source: from, branch }));
    const merged = await runGit(dir, ['merge', '--no-ff', '--no-edit', `origin/${from}`], 120_000);
    if (merged.code === 0) return;
    const conflicted = (await runGit(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((f) => f.trim()).filter(Boolean);
    if (!conflicted.length) throw new Error(t('合併失敗：{error}', { error: (merged.stderr || merged.stdout).trim().split('\n').slice(-2).join(' ') }));
    deps.progress(t('AI 解 {count} 個檔案的衝突', { count: conflicted.length }));
    const result = await deps.resolveWithAi(dir, buildMergePrompt({ ...old, source: from, branch, conflicted, ticket }));
    if (!result.resolved) throw new Error(t('AI 沒把握，沒有硬合：{reason}', { reason: result.reason || t('沒有說明') }));
    const left = conflicted.filter((f) => existsSync(join(dir, f)) && MARKERS.test(readFileSync(join(dir, f), 'utf8')));
    if (left.length) throw new Error(t('還有衝突標記沒清掉：{files}', { files: left.join(t('、')) }));
    await runGit(dir, ['add', '-A', '--', ...conflicted]);
    if ((await runGit(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim()) throw new Error(t('還有沒解完的衝突'));
    deps.progress(t('提交合併（專案的提交前檢查可能要等一陣子）'));
    const before = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();
    await loginShell(dir, 'git commit --no-edit', 30 * 60_000).catch(async (error) => {
      // 回報失敗、但其實提交了：當成成功（跟一般提交一樣）
      if ((await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim() === before) throw error;
    });
    deps.log(`${ticket.key} 解衝突（${from} → ${branch}）：${result.files.map((f) => `${f.file}（${f.how}）`).join('；')}`);
  };

  try {
    // 分支已經有了：先合最新的目標分支，再合開發分支的新改動；新開的分支本來就是最新的目標分支
    if (existing) await mergeIn(old.target);
    if (!self) await mergeIn(old.source);

    deps.progress(t('推送 {branch}', { branch }));
    const ref = `HEAD:refs/heads/${branch}`.replace(/'/g, `'\\''`);
    await loginShell(dir, `git push origin '${ref}'`, 5 * 60_000);

    if (self) return { pr: await deps.azure.getPr(old.id), mode: 'self' };
    const same = existing ? (await deps.azure.activePrs(branch)).find((p) => p.target === old.target) : undefined;
    let pr: PrRecord;
    if (same) {
      pr = same;
    } else {
      deps.progress(t('發新的 PR'));
      const description = `${old.description}\n\n${zhOnly(`（跟 ${old.target} 有衝突：從最新的 ${old.target} 開 ${branch}，把 ${old.source} 合併進來解完衝突後重發；原本的 PR !${old.id} 已放棄）`)}`;
      const created = await deps.azure.createPr({ source: branch, target: old.target, title: old.title, description, reviewerIds: old.reviewerIds });
      pr = await deps.azure.getPr(created.id).catch(() => ({ id: created.id, url: created.url, target: old.target, title: old.title, status: 'active' as const }));
    }
    deps.progress(t('放棄舊的 PR'));
    await deps.azure.abandonPr(old.id).catch((error) => deps.log(`${ticket.key} 新內容在 !${pr.id}，但放棄舊 PR !${old.id} 失敗：${(error as Error).message}`));
    return { pr, mode: same ? 'updated' : 'new' };
  } catch (error) {
    // 做到一半失敗：合併收掉；本機沒有建分支、遠端分支不刪；舊 PR 沒動
    await runGit(dir, ['merge', '--abort']);
    throw error;
  } finally {
    await runGit(deps.repoDir, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    await runGit(deps.repoDir, ['worktree', 'prune']);
  }
}

function buildMergePrompt(input: PrDetail & { branch: string; conflicted: string[]; ticket: { key: string; summary: string } }): string {
  return [
    '## 解衝突',
    `這是 FlowPilot 開的暫時資料夾，目前在分支 ${input.branch}（從最新的 origin/${input.target} 開出來），正在把開發分支 origin/${input.source}（${input.ticket.key} ${input.ticket.summary}）合併進來，有衝突。`,
    '',
    '有衝突的檔案：',
    ...input.conflicted.map((f) => `- ${f}`),
    '',
    `- 每個檔案照兩邊的意圖合併：${input.target} 上別人的改動要保留，這張單的功能也要保留。不要整個只挑一邊。`,
    '- 可以用 git log、git diff、git show 看兩邊各改了什麼（例如 git log --oneline -5 origin/' + input.target + ' -- 檔案、git show origin/' + input.source + ':檔案）。',
    '- 只改衝突的地方，把 <<<<<<< ======= >>>>>>> 標記全部清掉；其他地方不要動。',
    '- 不要 git add、git commit、git push，也不要切換分支（FlowPilot 會做）。',
    '- 有任何一處沒把握（兩邊的邏輯互相矛盾、不知道該留哪個、要問人才知道）：resolved 填 false，reason 寫清楚是哪個檔案、哪裡、為什麼，不要硬合。',
    '- files：每個檔案一句話說怎麼合的。給人看的文字用繁體中文（台灣）。',
  ].join('\n');
}

export const mergeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['resolved', 'files', 'reason'],
  properties: {
    resolved: { type: 'boolean' },
    files: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['file', 'how'], properties: { file: { type: 'string' }, how: { type: 'string' } } },
    },
    reason: { type: 'string' },
  },
};
