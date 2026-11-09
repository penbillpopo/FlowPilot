// 用 Azure DevOps 發 PR：沿用你推送時的 git 憑證（git credential fill），不另外登入；憑證不寫進紀錄、不顯示。
// 審核人從這個專案最近的 PR 抓出曾經審核過的人；目標分支從遠端的分支列出。
import { inChinese, t } from '../shared/i18n';
import { spawn } from 'node:child_process';
import type { AcceptanceItem, PrMergeCheck, PrOptions, PrRecord, PrReviewer, WorkItem } from '../shared/types';
import { runGit } from './git';

export interface RepoInfo {
  /** 例如 https://intellianalyzeorg.visualstudio.com */
  orgUrl: string;
  project: string;
  repo: string;
  host: string;
  /** 在網頁上看這個專案的網址（PR 連結用） */
  webUrl: string;
}

/** 從遠端網址讀出組織、專案、repo（支援 xxx.visualstudio.com 和 dev.azure.com 兩種寫法）；不是 Azure 就是 null */
export function parseAzureRemote(remote: string): RepoInfo | null {
  let url: URL;
  try {
    url = new URL(remote.trim());
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const git = parts.indexOf('_git');
  if (git < 1 || !parts[git + 1]) return null;
  if (url.host.endsWith('.visualstudio.com')) {
    const orgUrl = `https://${url.host}`;
    const project = parts[git - 1];
    return { orgUrl, project, repo: parts[git + 1], host: url.host, webUrl: `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(parts[git + 1])}` };
  }
  if (url.host === 'dev.azure.com' && git >= 2) {
    const orgUrl = `https://dev.azure.com/${encodeURIComponent(parts[0])}`;
    const project = parts[git - 1];
    return { orgUrl, project, repo: parts[git + 1], host: url.host, webUrl: `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(parts[git + 1])}` };
  }
  return null;
}

/** 讀出 git 存的憑證（跟推送用的同一組）；讀不到就丟錯 */
function credential(cwd: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'fill'], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      const user = out.match(/^username=(.*)$/m)?.[1] ?? '';
      const pass = out.match(/^password=(.*)$/m)?.[1] ?? '';
      if (!pass) return reject(new Error(t('這台電腦的 git 沒有存 {host} 的憑證，請先在這個專案推送一次', { host })));
      resolve('Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
    });
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });
}

interface AzurePr {
  pullRequestId: number;
  title: string;
  targetRefName: string;
  sourceRefName?: string;
  status: string;
  description?: string;
  /** Azure 試合併的結果：conflicts 是有衝突 */
  mergeStatus?: string;
  reviewers?: { id?: string; displayName: string; uniqueName: string; isContainer?: boolean; isRequired?: boolean; vote?: number }[];
  lastMergeSourceCommit?: { commitId: string };
  repository?: { project?: { id: string } };
}

/** PR 的規則檢查結果（Azure 的 policy evaluation） */
export interface PolicyState {
  name: string;
  status: string;
  blocking: boolean;
}

/** 審核人相關的規則：你自己核准就能通過（規則允許發 PR 的人自己投票） */
const REVIEW_POLICIES = ['Minimum number of reviewers', 'Required reviewers'];

/**
 * 這個 PR 能不能在 FlowPilot 完成合併（你的規定，2026-11-09）：
 * - 正式環境分支（設定檔的 prodBranches）不能；設定檔沒寫正式環境分支的專案一律不能
 * - 有選其他審核人（Azure 自動加的必要審核群組、你自己不算）不能：要等他們
 * - 有衝突、還在試合併、你投了拒絕、其他規則（例如建置）沒過：不能
 * - 只差審核人規則：可以，要先用你的帳號核准（needApprove）
 */
export function mergeDecision(pr: AzurePr, policies: PolicyState[], me: string, prodBranches: string[] | undefined): PrMergeCheck {
  const target = pr.targetRefName.replace(/^refs\/heads\//, '');
  const no = (reason: string): PrMergeCheck => ({ canMerge: false, needApprove: false, reason });
  if (pr.status !== 'active') return no(t('這個 PR 已經不是審核中'));
  if (!prodBranches) return no(t('設定檔沒寫這個專案的正式環境分支（prodBranches），不能在 FlowPilot 合併'));
  if (prodBranches.includes(target)) return no(t('{target} 是正式環境分支，不能在 FlowPilot 合併', { target }));
  const reviewers = pr.reviewers ?? [];
  const others = reviewers.filter((r) => r.id !== me && !(r.isContainer && r.isRequired));
  if (others.length) return no(t('有選審核人 {names}，要等他們審核合併', { names: others.map((r) => r.uniqueName?.includes('@') ? r.uniqueName : r.displayName).join(t('、')) }));
  if (pr.mergeStatus === 'conflicts') return no(t('有衝突，先解衝突'));
  if (pr.mergeStatus !== 'succeeded') return no(t('Azure 還在檢查能不能合併，等一下再看'));
  const myVote = reviewers.find((r) => r.id === me)?.vote ?? 0;
  if (myVote < 0) return no(t('你在 Azure 上投了拒絕或等待作者，要先改掉'));
  const failing = policies.filter((p) => p.blocking && !['approved', 'notApplicable'].includes(p.status));
  const other = failing.filter((p) => !REVIEW_POLICIES.includes(p.name));
  if (other.length) return no(t('還有規則沒通過：{names}', { names: other.map((p) => p.name).join(t('、')) }));
  if (failing.length && myVote >= 10) return { ...no(t('你已經核准了，但審核規則還沒通過：{names}', { names: failing.map((p) => p.name).join(t('、')) })), approvedPending: true };
  return { canMerge: true, needApprove: failing.length > 0, reason: '' };
}

/** 解衝突重發要用的：原本 PR 的名稱、說明、審核人、來源和目標分支 */
export interface PrDetail {
  id: number;
  title: string;
  description: string;
  source: string;
  target: string;
  reviewerIds: string[];
  status: PrRecord['status'];
  conflicts: boolean;
}

/** 從 PR 網址讀出編號（舊資料只存了網址） */
export function prIdFromUrl(url: string): number {
  return Number(url.match(/pullrequest\/(\d+)/)?.[1] ?? 0);
}

/** 設定檔有寫審核人（信箱）就只留這些人（照設定的順序）；沒寫就全部 */
export function pickReviewers(all: PrReviewer[], wanted: string[] | undefined): PrReviewer[] {
  if (!wanted?.length) return all;
  const byEmail = new Map(all.map((r) => [r.email.toLowerCase(), r]));
  return wanted.map((email) => byEmail.get(String(email).trim().toLowerCase())).filter((r): r is PrReviewer => !!r);
}

export class AzureRepo {
  private constructor(
    readonly info: RepoInfo,
    private readonly auth: string,
  ) {}

  /** 用資料夾的遠端網址和 git 憑證連上 Azure */
  static async open(cwd: string): Promise<AzureRepo> {
    const remote = (await runGit(cwd, ['remote', 'get-url', 'origin'])).stdout.trim();
    const info = parseAzureRemote(remote);
    if (!info) throw new Error(t('這個專案的遠端不在 Azure DevOps 上'));
    return new AzureRepo(info, await credential(cwd, info.host));
  }

  private async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.info.orgUrl}/${encodeURIComponent(this.info.project)}/_apis/git/repositories/${encodeURIComponent(this.info.repo)}${path}${path.includes('?') ? '&' : '?'}api-version=7.1`;
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 203) throw new Error(t('Azure 不接受這組憑證（可能過期了），請重新推送一次讓 git 更新憑證'));
    if (response.status === 403) throw new Error(t('這組憑證的權限不夠（需要 Code 的讀寫權限）'));
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      throw new Error(t('Azure 回傳 {status}：{message}', { status: response.status, message: message.slice(0, 300) }));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** 最近的 PR 裡審核過的人（團隊之類的群組不算），審核次數多的在前 */
  async recentReviewers(): Promise<PrReviewer[]> {
    const { value } = await this.api<{ value: { reviewers?: { id: string; displayName: string; uniqueName: string; isContainer?: boolean }[] }[] }>(
      '/pullrequests?searchCriteria.status=all&$top=50',
    );
    const count = new Map<string, PrReviewer & { n: number }>();
    for (const pr of value) {
      for (const r of pr.reviewers ?? []) {
        if (r.isContainer) continue;
        const seen = count.get(r.id) ?? { id: r.id, name: r.displayName, email: r.uniqueName, n: 0 };
        seen.n++;
        count.set(r.id, seen);
      }
    }
    return [...count.values()].sort((a, b) => b.n - a.n).map(({ n: _, ...r }) => r);
  }

  /**
   * 發 PR 可以選的目標分支。wanted（設定檔的 prTargets）有寫就只列這些、照這個順序（遠端沒有的不列）；
   * 沒寫就列 master、sit、uat、version、release、dev 開頭的。
   */
  async targetBranches(wanted?: string[]): Promise<string[]> {
    // 分好幾次查：遠端有上千條個人分支，一次全拿會被截斷（實際發生過，master-8 這些被截掉）
    const prefixes = wanted?.length ? [...new Set(wanted.map((w) => w.split(/[-/]/)[0]))] : ['master', 'main', 'sit', 'uat', 'version', 'release', 'dev'];
    const lists = await Promise.all(prefixes.map((p) => this.api<{ value: { name: string }[] }>(`/refs?filter=${encodeURIComponent(`heads/${p}`)}&$top=500`)));
    const names = new Set(lists.flatMap((l) => l.value.map((r) => r.name.replace(/^refs\/heads\//, ''))));
    if (wanted?.length) return wanted.filter((w) => names.has(w));
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  async branchExists(branch: string): Promise<boolean> {
    const { value } = await this.api<{ value: { name: string }[] }>(`/refs?filter=${encodeURIComponent(`heads/${branch}`)}`);
    return value.some((r) => r.name === `refs/heads/${branch}`);
  }

  /** 這條分支還開著的 PR（同一個目標分支不重複建立；不同目標分支可以各發一個） */
  async activePrs(branch: string): Promise<PrRecord[]> {
    const { value } = await this.api<{ value: AzurePr[] }>(
      `/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}`,
    );
    return value.map((pr) => this.record(pr));
  }

  /** 讀一個 PR 現在的樣子（狀態、目標分支、審核人） */
  async getPr(id: number): Promise<PrRecord> {
    return this.record(await this.api<AzurePr>(`/pullrequests/${id}`));
  }

  private record(pr: AzurePr): PrRecord {
    const status = pr.status === 'completed' || pr.status === 'abandoned' ? pr.status : 'active';
    return {
      id: pr.pullRequestId,
      url: this.prUrl(pr.pullRequestId),
      title: pr.title,
      target: pr.targetRefName.replace(/^refs\/heads\//, ''),
      reviewers: (pr.reviewers ?? []).filter((r) => !r.isContainer).map((r) => r.uniqueName || r.displayName),
      status,
      ...(status === 'active' && pr.mergeStatus === 'conflicts' ? { conflicts: true } : {}),
    };
  }

  /** 解衝突重發要用的 PR 內容 */
  async prDetail(id: number): Promise<PrDetail> {
    const pr = await this.api<AzurePr>(`/pullrequests/${id}`);
    const record = this.record(pr);
    return {
      id,
      title: pr.title,
      description: pr.description ?? '',
      source: (pr.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      target: record.target,
      reviewerIds: (pr.reviewers ?? []).filter((r) => !r.isContainer && r.id).map((r) => r.id!),
      status: record.status,
      conflicts: !!record.conflicts,
    };
  }

  /** 組織層級的 API（不在倉庫底下的，例如目前登入的是誰、PR 的規則檢查） */
  private async orgApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.info.orgUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(t('Azure 回傳 {status}：{message}', { status: response.status, message: text.slice(0, 300) }));
    return (text ? JSON.parse(text) : {}) as T;
  }

  private myId?: string;
  /** 這組憑證是誰（核准用你的帳號） */
  async me(): Promise<string> {
    this.myId ??= (await this.orgApi<{ authenticatedUser: { id: string } }>('/_apis/connectionData')).authenticatedUser.id;
    return this.myId;
  }

  private async policies(pr: AzurePr): Promise<PolicyState[]> {
    const projectId = pr.repository?.project?.id;
    if (!projectId) return [];
    const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}`);
    const { value } = await this.orgApi<{ value: { status: string; configuration?: { isBlocking?: boolean; isEnabled?: boolean; type?: { displayName?: string } } }[] }>(
      `/${encodeURIComponent(this.info.project)}/_apis/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`,
    );
    return value.filter((e) => e.configuration?.isEnabled !== false).map((e) => ({ name: e.configuration?.type?.displayName ?? '', status: e.status, blocking: !!e.configuration?.isBlocking }));
  }

  /** 能不能在 FlowPilot 完成合併（只讀） */
  async mergeCheck(id: number, prodBranches: string[] | undefined): Promise<PrMergeCheck> {
    const pr = await this.api<AzurePr>(`/pullrequests/${id}`);
    if (pr.status !== 'active') return mergeDecision(pr, [], '', prodBranches);
    return mergeDecision(pr, await this.policies(pr), await this.me(), prodBranches);
  }

  /**
   * 完成合併：送出前再檢查一次（不能合併就丟錯）；只差審核就先用你的帳號核准，等規則通過再合併。
   * 跟 Azure 網頁的預設一樣：Merge (no fast forward)、不刪來源分支、不動工作項目、合併訊息不改。
   */
  async completePr(id: number, prodBranches: string[] | undefined, progress: (text: string) => void = () => {}, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<PrRecord> {
    const check = await this.mergeCheck(id, prodBranches);
    if (!check.canMerge) throw new Error(check.reason);
    const me = await this.me();
    if (check.needApprove) {
      progress(t('用你的帳號核准'));
      await this.api(`/pullrequests/${id}/reviewers/${me}`, { method: 'PUT', body: { vote: 10 } });
      progress(t('等 Azure 的審核規則通過'));
      for (let i = 0; ; i++) {
        await wait(2000);
        const again = await this.mergeCheck(id, prodBranches);
        if (again.canMerge && !again.needApprove) break;
        if (!again.canMerge && !again.approvedPending) throw new Error(again.reason);
        if (i >= 15) throw new Error(t('核准了，但 Azure 的審核規則 30 秒內沒有通過，請到 Azure 看一下'));
      }
    }
    progress(t('完成合併'));
    const pr = await this.api<AzurePr>(`/pullrequests/${id}`);
    await this.api(`/pullrequests/${id}`, {
      method: 'PATCH',
      body: {
        status: 'completed',
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false },
      },
    });
    // Azure 是在背景合併：等它真的變成已合併
    for (let i = 0; i < 15; i++) {
      const record = await this.getPr(id);
      if (record.status === 'completed') return record;
      await wait(2000);
    }
    return this.getPr(id);
  }

  /** 放棄一個 PR（Azure 的 PR 不能刪除，放棄就是收掉） */
  async abandonPr(id: number): Promise<void> {
    await this.api(`/pullrequests/${id}`, { method: 'PATCH', body: { status: 'abandoned' } });
  }

  async createPr(input: { source: string; target: string; title: string; description: string; reviewerIds: string[] }): Promise<{ id: number; url: string }> {
    const pr = await this.api<{ pullRequestId: number }>('/pullrequests', {
      method: 'POST',
      body: {
        sourceRefName: `refs/heads/${input.source}`,
        targetRefName: `refs/heads/${input.target}`,
        title: input.title,
        description: input.description.slice(0, 4000), // Azure 的上限
        reviewers: input.reviewerIds.map((id) => ({ id })),
      },
    });
    return { id: pr.pullRequestId, url: this.prUrl(pr.pullRequestId) };
  }

  prUrl(id: number): string {
    return `${this.info.webUrl}/pullrequest/${id}`;
  }
}

/** PR 預設的名稱：feat(單號) 單子名稱 */
export function defaultPrTitle(item: Pick<WorkItem, 'ticketKey' | 'ticketSummary'> & { members?: WorkItem['members'] }): string {
  // 合成任務列出全部單號：feat(ALL-1, ALL-2) 標題
  const keys = item.members?.length ? item.members.map((m) => m.key).join(', ') : item.ticketKey;
  return `feat(${keys}) ${item.ticketSummary}`.trim();
}

/** PR 說明：Jira 連結＋驗收表的「改了什麼、怎麼測」 */
/** PR 說明：給團隊看的，固定用中文（不管介面語言） */
export function prDescription(item: Parameters<typeof buildPrDescription>[0]): string {
  return inChinese(() => buildPrDescription(item));
}

function buildPrDescription(item: Pick<WorkItem, 'ticketKey' | 'ticketSummary' | 'mainKey' | 'mainUrl' | 'testReport' | 'branch' | 'baseBranch'> & { portOf?: WorkItem['portOf']; members?: WorkItem['members'] }): string {
  const ticketUrl = item.mainUrl ? item.mainUrl.replace(/browse\/[^/?#]+/, `browse/${item.ticketKey}`) : '';
  const lines = item.members?.length
    ? [t('Jira（合成一個任務）：'), ...item.members.map((m) => `- [${m.key}](${m.url}) ${m.summary}`)]
    : [`${t('Jira：')}[${item.ticketKey}](${ticketUrl || item.ticketKey}) ${item.ticketSummary}`];
  // 移植過來的：寫清楚從哪裡移植（跟 platform-web-copy 的 PR 說明一樣）
  if (item.portOf) lines.push('', `Port feature from ${item.portOf.branch} to ${item.baseBranch}`, '', 'Source:', `${item.portOf.baseBranch} -> ${item.portOf.branch}`, '', 'Target:', `${item.baseBranch} -> ${item.branch}`);
  if (item.mainKey && item.mainKey !== item.ticketKey && item.mainUrl) lines.push(`${t('主單：')}[${item.mainKey}](${item.mainUrl})`);
  const report = item.testReport;
  const items = (report?.acceptance ?? []).filter((a: AcceptanceItem) => a.change || a.howToTest);
  if (items.length) {
    lines.push('', t('## 改了什麼、怎麼測'));
    for (const a of items) {
      lines.push(`${a.no}. **${a.text}**`);
      if (a.change) lines.push(t('   - 改了：{text}', { text: a.change }));
      if (a.impact) lines.push(t('   - 也影響：{text}', { text: a.impact }));
      if (a.howToTest) lines.push(t('   - 怎麼測：{text}', { text: a.howToTest }));
    }
  }
  if (report?.otherChanges.length) {
    lines.push('', t('## 其他也改到的'));
    for (const c of report.otherChanges) lines.push(`- ${c.change}${c.impact ? t('（也影響：{impact}）', { impact: c.impact }) : ''}`);
  }
  return lines.join('\n');
}

export type { PrOptions };
