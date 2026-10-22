// 分支規則：純計算，不碰 git，方便測試。
import { t } from '../../shared/i18n';
import type { PlanBranch, PlanEntry, TicketPlan } from '../../shared/types';
import type { ProjectRule, Settings } from '../settings';

export function fill(template: string, values: { merchant: number | null; key: string }): string {
  return template.replaceAll('{商戶}', values.merchant === null ? '' : String(values.merchant)).replaceAll('{單號}', values.key.toUpperCase());
}

/** 第幾版的分支名稱：1（或沒選）是原本的名稱，2 起加上 -2、-3 */
export function withSeq(branch: string, seq: number | undefined): string {
  return seq && seq > 1 ? `${branch}-${seq}` : branch;
}

/** 分支名稱是不是 root 的某一版；是的話回傳第幾版 */
export function seqOf(branch: string, root: string): number | null {
  if (branch === root) return 1;
  const m = branch.startsWith(`${root}-`) ? /^(\d+)$/.exec(branch.slice(root.length + 1)) : null;
  return m && Number(m[1]) > 1 ? Number(m[1]) : null;
}

export function hasMerchants(rule: ProjectRule): boolean {
  return !!rule.merchants?.length;
}

/** 多商戶時的來源商戶：依優先順序（例如 1 > 5 > 8），沒列到的依數字小到大 */
export function pickSourceMerchant(merchants: number[], priority: number[] = []): number | null {
  if (merchants.length === 0) return null;
  const prioritized = priority.find((m) => merchants.includes(m));
  return prioritized ?? [...merchants].sort((a, b) => a - b)[0];
}

/** 把 AI 或你填的內容整理成合法的計畫：商戶排序去重、來源商戶補齊 */
export function normalizeEntry(entry: PlanEntry, rule: ProjectRule): PlanEntry {
  if (!hasMerchants(rule)) return { ...entry, merchants: [], sourceMerchant: null };
  const merchants = [...new Set(entry.merchants)].filter((m) => rule.merchants!.includes(m)).sort((a, b) => a - b);
  const sourceMerchant =
    entry.sourceMerchant !== null && merchants.includes(entry.sourceMerchant)
      ? entry.sourceMerchant
      : pickSourceMerchant(merchants, rule.sourcePriority);
  return { ...entry, merchants, sourceMerchant };
}

/** 計畫有沒有填完整；回傳要你補的地方，沒問題回傳 null */
export function planProblem(plan: TicketPlan, settings: Settings): string | null {
  if (plan.entries.length === 0) return t('還沒選專案');
  for (const entry of plan.entries) {
    const rule = settings.projects[entry.project];
    if (!rule) return t('沒有「{project}」的分支規則', { project: entry.project });
    if (hasMerchants(rule) && entry.merchants.length === 0) return t('{project} 還沒選商戶', { project: entry.project });
  }
  const projects = plan.entries.map((e) => e.project);
  if (new Set(projects).size !== projects.length) return t('同一個專案出現兩次');
  if (!/^feat\([A-Z]+-\d+(, ?[A-Z]+-\d+)*\) \S/.test(plan.prTitle)) return t('合併請求標題格式要是 feat(單號) 英文描述');
  return null;
}

/** 一張單展開成哪些分支（還沒檢查是否已存在） */
export function deriveBranches(plan: TicketPlan, settings: Settings): PlanBranch[] {
  const key = plan.ticket.key;
  const branches: PlanBranch[] = [];
  for (const raw of plan.entries) {
    const rule = settings.projects[raw.project];
    if (!rule) continue;
    const entry = normalizeEntry(raw, rule);
    const make = (merchant: number | null, role: PlanBranch['role']): PlanBranch => {
      const root = fill(rule.branch, { merchant, key });
      return {
        ticketKey: key,
        project: entry.project,
        merchant,
        role,
        branch: withSeq(root, entry.branchSeq),
        baseBranch: fill(rule.baseBranch, { merchant, key }),
        existsIn: [],
        root,
        versions: [],
      };
    };
    if (!hasMerchants(rule)) {
      branches.push(make(null, 'single'));
    } else if (entry.merchants.length === 1) {
      branches.push(make(entry.merchants[0], 'single'));
    } else {
      branches.push(make(entry.sourceMerchant, 'source'));
      for (const m of entry.merchants) if (m !== entry.sourceMerchant) branches.push(make(m, 'target'));
    }
  }
  return branches;
}
