// 分配資料夾：純計算，方便測試。
import type { FolderSetting, ProjectRule } from '../settings';

/** 分支名稱裡的商戶編號，例如 ban/m8/ALL-1 → 8 */
export function merchantOfBranch(branch: string): number | null {
  const match = branch.match(/(?:^|\/)m(\d+)\//) ?? branch.match(/^master-(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function dependencyGroup(rule: ProjectRule, merchant: number | null): string | null {
  if (merchant === null) return null;
  for (const [name, merchants] of Object.entries(rule.dependencyGroups ?? {})) if (merchants.includes(merchant)) return name;
  return null;
}

/**
 * 挑一個空著的資料夾給這個工作項目；沒有就回傳 null（繼續排隊）。
 * 有套件群組的專案，優先挑目前分支同群組的資料夾，切過去不用重新安裝套件。
 */
export function pickFolder(
  item: { project: string; merchant: number | null },
  folders: FolderSetting[],
  occupied: Set<string>,
  currentBranches: Record<string, string>,
  rule: ProjectRule,
): FolderSetting | null {
  const free = folders.filter((f) => f.project === item.project && !occupied.has(f.name));
  if (free.length <= 1) return free[0] ?? null;
  const wanted = dependencyGroup(rule, item.merchant);
  if (wanted === null) return free[0];
  return free.find((f) => dependencyGroup(rule, merchantOfBranch(currentBranches[f.name] ?? '')) === wanted) ?? free[0];
}
