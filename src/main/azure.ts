// 用 Azure DevOps 發 PR：沿用你推送時的 git 憑證（git credential fill），不另外登入；憑證不寫進紀錄、不顯示。
// 審核人從這個專案最近的 PR 抓出曾經審核過的人；目標分支從遠端的分支列出。
import { spawn } from 'node:child_process';
import type { AcceptanceItem, PrOptions, PrRecord, PrReviewer, WorkItem } from '../shared/types';
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
      if (!pass) return reject(new Error(`這台電腦的 git 沒有存 ${host} 的憑證，請先在這個專案推送一次`));
      resolve('Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
    });
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });
}

interface AzurePr {
  pullRequestId: number;
  title: string;
  targetRefName: string;
  status: string;
  reviewers?: { displayName: string; uniqueName: string; isContainer?: boolean }[];
}

/** 從 PR 網址讀出編號（舊資料只存了網址） */
export function prIdFromUrl(url: string): number {
  return Number(url.match(/pullrequest\/(\d+)/)?.[1] ?? 0);
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
    if (!info) throw new Error('這個專案的遠端不在 Azure DevOps 上');
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
    if (response.status === 401 || response.status === 203) throw new Error('Azure 不接受這組憑證（可能過期了），請重新推送一次讓 git 更新憑證');
    if (response.status === 403) throw new Error('這組憑證的權限不夠（需要 Code 的讀寫權限）');
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      throw new Error(`Azure 回傳 ${response.status}：${message.slice(0, 300)}`);
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

  /** 遠端的分支（只列 PR 會用到的：master、sit、uat、version、release、develop 開頭的） */
  async targetBranches(): Promise<string[]> {
    // 分好幾次查：遠端有上千條個人分支，一次全拿會被截斷（實際發生過，master-8 這些被截掉）
    const prefixes = ['master', 'main', 'sit', 'uat', 'version', 'release', 'develop'];
    const lists = await Promise.all(prefixes.map((p) => this.api<{ value: { name: string }[] }>(`/refs?filter=${encodeURIComponent(`heads/${p}`)}&$top=500`)));
    const names = new Set(lists.flatMap((l) => l.value.map((r) => r.name.replace(/^refs\/heads\//, ''))));
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
    return {
      id: pr.pullRequestId,
      url: this.prUrl(pr.pullRequestId),
      title: pr.title,
      target: pr.targetRefName.replace(/^refs\/heads\//, ''),
      reviewers: (pr.reviewers ?? []).filter((r) => !r.isContainer).map((r) => r.uniqueName || r.displayName),
      status: pr.status === 'completed' || pr.status === 'abandoned' ? pr.status : 'active',
    };
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
export function prDescription(item: Pick<WorkItem, 'ticketKey' | 'ticketSummary' | 'mainKey' | 'mainUrl' | 'testReport' | 'branch' | 'baseBranch'> & { portOf?: WorkItem['portOf']; members?: WorkItem['members'] }): string {
  const ticketUrl = item.mainUrl ? item.mainUrl.replace(/browse\/[^/?#]+/, `browse/${item.ticketKey}`) : '';
  const lines = item.members?.length
    ? ['Jira（合成一個任務）：', ...item.members.map((m) => `- [${m.key}](${m.url}) ${m.summary}`)]
    : [`Jira：[${item.ticketKey}](${ticketUrl || item.ticketKey}) ${item.ticketSummary}`];
  // 移植過來的：寫清楚從哪裡移植（跟 platform-web-copy 的 PR 說明一樣）
  if (item.portOf) lines.push('', `Port feature from ${item.portOf.branch} to ${item.baseBranch}`, '', 'Source:', `${item.portOf.baseBranch} -> ${item.portOf.branch}`, '', 'Target:', `${item.baseBranch} -> ${item.branch}`);
  if (item.mainKey && item.mainKey !== item.ticketKey && item.mainUrl) lines.push(`主單：[${item.mainKey}](${item.mainUrl})`);
  const report = item.testReport;
  const items = (report?.acceptance ?? []).filter((a: AcceptanceItem) => a.change || a.howToTest);
  if (items.length) {
    lines.push('', '## 改了什麼、怎麼測');
    for (const a of items) {
      lines.push(`${a.no}. **${a.text}**`);
      if (a.change) lines.push(`   - 改了：${a.change}`);
      if (a.impact) lines.push(`   - 也影響：${a.impact}`);
      if (a.howToTest) lines.push(`   - 怎麼測：${a.howToTest}`);
    }
  }
  if (report?.otherChanges.length) {
    lines.push('', '## 其他也改到的');
    for (const c of report.otherChanges) lines.push(`- ${c.change}${c.impact ? `（也影響：${c.impact}）` : ''}`);
  }
  return lines.join('\n');
}

export type { PrOptions };
