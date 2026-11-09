// 解衝突重發：用暫存的 git 倉庫做出真的衝突，Azure 和 AI 用假的，不碰真正的專案和 Azure。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PrDetail } from '../src/main/azure';
import { type AiMergeResult, conflictBranchFor, conflictBranchName, resolvePrConflict } from '../src/main/pr-conflict';
import type { PrRecord } from '../src/shared/types';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** 遠端有 dev 和 ban/ALL-1；conflict 為 true 時兩邊改了同一行 */
function setup(conflict = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowpilot-conflict-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'dev', remote);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  git(seed, 'config', 'user.name', 't');
  git(seed, 'config', 'user.email', 't@t');
  writeFileSync(join(seed, 'a.ts'), 'title\nline\n');
  writeFileSync(join(seed, 'b.ts'), 'b\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'dev');
  git(seed, 'switch', '-q', '-c', 'ban/ALL-1');
  writeFileSync(join(seed, conflict ? 'a.ts' : 'b.ts'), conflict ? 'title\nfeature line\n' : 'feature b\n');
  git(seed, 'commit', '-qam', 'feature');
  git(seed, 'push', '-q', 'origin', 'ban/ALL-1');
  git(seed, 'switch', '-q', 'dev');
  writeFileSync(join(seed, 'a.ts'), 'title\nsomeone else line\n');
  git(seed, 'commit', '-qam', 'other work on dev');
  git(seed, 'push', '-q', 'origin', 'dev');

  // 專案資料夾：停在別的分支、有沒提交的改動（不能被動到）
  const repo = join(root, 'PlatformAdmin');
  git(root, 'clone', '-q', remote, repo);
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'switch', '-q', '-c', 'ban/ALL-9');
  writeFileSync(join(repo, 'b.ts'), 'my unsaved work\n');

  const calls: string[] = [];
  const created: { source: string; target: string; title: string; description: string; reviewerIds: string[] }[] = [];
  const detail: PrDetail = { id: 5, title: 'feat(ALL-1) x', description: 'Jira：ALL-1', source: 'ban/ALL-1', target: 'dev', reviewerIds: ['mcl-id'], status: 'active', conflicts: true };
  const remoteHas = (branch: string) => git(root, 'ls-remote', '--heads', remote, branch) !== '';
  const azure = {
    prDetail: async () => detail,
    branchExists: async (branch: string) => remoteHas(branch),
    createPr: async (input: (typeof created)[number]) => (calls.push('create'), created.push(input), { id: 6, url: 'https://x/pullrequest/6' }),
    abandonPr: async (id: number) => void calls.push(`abandon ${id}`),
    getPr: async (id: number): Promise<PrRecord> => ({ id, url: `https://x/pullrequest/${id}`, target: 'dev', title: detail.title, status: 'active' }),
    activePrs: async (branch: string): Promise<PrRecord[]> => active[branch] ?? [],
  };
  const active: Record<string, PrRecord[]> = {};
  const progress: string[] = [];
  const run = (ai: (cwd: string, prompt: string) => Promise<AiMergeResult>) =>
    resolvePrConflict({ repoDir: repo, workDir: join(root, 'work'), azure, resolveWithAi: ai, progress: (p) => progress.push(p), log: () => {} }, 5, { key: 'ALL-1', summary: 'x' });
  return { root, remote, repo, seed, calls, created, run, remoteHas, progress, detail, active };
}

describe('解衝突重發', () => {
  it('新分支名稱：原分支名加目標分支名，斜線換成橫線', () => {
    expect(conflictBranchName('ban/ALL-1', 'dev')).toBe('ban/ALL-1-dev');
    expect(conflictBranchName('ban/m1/ALL-1', 'uat-1')).toBe('ban/m1/ALL-1-uat-1');
    expect(conflictBranchName('ban/ALL-1', 'version/0.0.1')).toBe('ban/ALL-1-version-0.0.1');
  });

  it('從最新的目標分支開新分支、合併、AI 解衝突、推送、發新 PR，最後才放棄舊的；專案資料夾不動', async () => {
    const t = setup();
    let prompt = '';
    const { pr, mode } = await t.run(async (cwd, p) => {
      prompt = p;
      expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toContain('<<<<<<<');
      writeFileSync(join(cwd, 'a.ts'), 'title\nsomeone else line\nfeature line\n');
      return { resolved: true, files: [{ file: 'a.ts', how: '兩行都留' }], reason: '' };
    });
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('不要 git add、git commit、git push');
    // 新分支推上去了，內容是兩邊合起來的
    expect(t.remoteHas('ban/ALL-1-dev')).toBe(true);
    git(t.repo, 'fetch', '-q', 'origin');
    expect(git(t.repo, 'show', 'origin/ban/ALL-1-dev:a.ts')).toBe('title\nsomeone else line\nfeature line');
    // 用新分支發到同一個目標分支，名稱、審核人沿用；新的發成功才放棄舊的
    expect(t.created).toMatchObject([{ source: 'ban/ALL-1-dev', target: 'dev', title: 'feat(ALL-1) x', reviewerIds: ['mcl-id'] }]);
    expect(t.created[0].description).toContain('Jira：ALL-1');
    expect(t.calls).toEqual(['create', 'abandon 5']);
    expect(pr).toMatchObject({ id: 6, target: 'dev' });
    expect(mode).toBe('new');
    // 開發分支、專案資料夾都沒動；暫時資料夾收掉了
    expect(git(t.repo, 'branch', '--show-current')).toBe('ban/ALL-9');
    expect(readFileSync(join(t.repo, 'b.ts'), 'utf8')).toBe('my unsaved work\n');
    expect(t.remoteHas('ban/ALL-1')).toBe(true);
    expect(git(t.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  }, 60_000);

  it('AI 沒把握：停下來說原因，不推送、不發 PR、舊 PR 不動，也不留下新分支', async () => {
    const t = setup();
    await expect(t.run(async () => ({ resolved: false, files: [], reason: 'a.ts 兩邊的邏輯互相矛盾' }))).rejects.toThrow('兩邊的邏輯互相矛盾');
    expect(t.calls).toEqual([]);
    expect(t.remoteHas('ban/ALL-1-dev')).toBe(false);
    expect(git(t.repo, 'branch', '--list', 'ban/ALL-1-dev')).toBe('');
    expect(git(t.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  }, 60_000);

  it('AI 說解好了但還留著衝突標記：不推送', async () => {
    const t = setup();
    await expect(t.run(async () => ({ resolved: true, files: [], reason: '' }))).rejects.toThrow('衝突標記');
    expect(t.calls).toEqual([]);
  }, 60_000);

  it('合併沒有衝突：不用 AI，直接推送、重發', async () => {
    const t = setup(false);
    let asked = false;
    await t.run(async () => ((asked = true), { resolved: true, files: [], reason: '' }));
    expect(asked).toBe(false);
    expect(t.calls).toEqual(['create', 'abandon 5']);
  }, 60_000);

  it('分支名稱：PR 本身就是解衝突分支發的就沿用，不再加一層', () => {
    expect(conflictBranchFor('ban/ALL-1', 'master')).toBe('ban/ALL-1-master');
    expect(conflictBranchFor('ban/ALL-1-master', 'master')).toBe('ban/ALL-1-master');
    expect(conflictBranchFor('ban/ALL-1-version-0.0.1', 'version/0.0.1')).toBe('ban/ALL-1-version-0.0.1');
  });

  /** 第一次解完以後：目標分支和開發分支又各自往前走，而且又改到同一行 */
  async function afterFirstRound() {
    const t = setup();
    const both = async (cwd: string) => {
      writeFileSync(join(cwd, 'a.ts'), readFileSync(join(cwd, 'a.ts'), 'utf8').replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, '$1$2'));
      return { resolved: true, files: [{ file: 'a.ts', how: '兩邊都留' }], reason: '' };
    };
    await t.run(both);
    t.active['ban/ALL-1-dev'] = [{ id: 6, url: 'https://x/pullrequest/6', target: 'dev', title: 'feat(ALL-1) x', status: 'active' }];
    git(t.seed, 'fetch', '-q', 'origin');
    git(t.seed, 'switch', '-q', 'dev');
    git(t.seed, 'reset', '-q', '--hard', 'origin/dev');
    writeFileSync(join(t.seed, 'a.ts'), 'title2\nsomeone else line\n');
    git(t.seed, 'commit', '-qam', 'more on dev');
    git(t.seed, 'push', '-q', 'origin', 'dev');
    git(t.seed, 'switch', '-q', 'ban/ALL-1');
    writeFileSync(join(t.seed, 'c.ts'), 'more feature\n');
    git(t.seed, 'add', '.');
    git(t.seed, 'commit', '-qm', 'more feature');
    git(t.seed, 'push', '-q', 'origin', 'ban/ALL-1');
    git(t.repo, 'fetch', '-q', 'origin');
    const before = git(t.repo, 'rev-parse', 'origin/ban/ALL-1-dev');
    t.calls.length = 0;
    t.created.length = 0;
    return { t, both, before };
  }

  it('解衝突分支已經存在、上面有發到同一個目標的 PR：接著用它，推回同一條分支，不發新的，有衝突的放棄', async () => {
    const { t, both, before } = await afterFirstRound();
    // 開發分支又發了一次 PR（!7），跟 dev 有衝突
    Object.assign(t.detail, { id: 7, source: 'ban/ALL-1' });
    git(t.repo, 'branch', 'ban/ALL-1-dev', before); // 本機也有同名的舊分支：不影響
    const { pr, mode } = await t.run(both);
    expect(mode).toBe('updated');
    expect(pr.id).toBe(6);
    expect(t.created).toEqual([]);
    expect(t.calls).toEqual(['abandon 7']);
    git(t.repo, 'fetch', '-q', 'origin');
    // 一般推送：原本的提交都還在（沒有強制推送），最新的 dev 和開發分支的新改動都合進來了
    expect(git(t.repo, 'merge-base', '--is-ancestor', before, 'origin/ban/ALL-1-dev')).toBe('');
    expect(git(t.repo, 'show', 'origin/ban/ALL-1-dev:a.ts')).toContain('title2');
    expect(git(t.repo, 'show', 'origin/ban/ALL-1-dev:c.ts')).toBe('more feature');
    expect(git(t.repo, 'merge-base', '--is-ancestor', 'origin/dev', 'origin/ban/ALL-1-dev')).toBe('');
    expect(git(t.repo, 'rev-parse', 'ban/ALL-1-dev')).toBe(before);
    expect(git(t.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  }, 90_000);

  it('有衝突的 PR 就是從解衝突分支發的：把最新的目標分支合進去，PR 就地更新，不發新的也不放棄', async () => {
    const { t, both, before } = await afterFirstRound();
    Object.assign(t.detail, { id: 6, source: 'ban/ALL-1-dev' });
    const { pr, mode } = await t.run(both);
    expect(mode).toBe('self');
    expect(pr.id).toBe(6);
    expect(t.calls).toEqual([]);
    git(t.repo, 'fetch', '-q', 'origin');
    expect(git(t.repo, 'merge-base', '--is-ancestor', before, 'origin/ban/ALL-1-dev')).toBe('');
    expect(git(t.repo, 'merge-base', '--is-ancestor', 'origin/dev', 'origin/ban/ALL-1-dev')).toBe('');
    // 這次只合目標分支，開發分支的新改動不在這裡（那是另一個 PR 的事）
    expect(() => git(t.repo, 'show', 'origin/ban/ALL-1-dev:c.ts')).toThrow();
  }, 90_000);

  it('本機留著同名的舊分支（之前沒推上去）：照樣從最新的目標分支開始', async () => {
    const t = setup(false);
    git(t.repo, 'branch', 'ban/ALL-1-dev');
    const { mode } = await t.run(async () => ({ resolved: true, files: [], reason: '' }));
    expect(mode).toBe('new');
    expect(t.calls).toEqual(['create', 'abandon 5']);
  }, 60_000);
});
