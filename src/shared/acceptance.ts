// 驗收表的共用判斷（主程式和畫面都會用到）
import type { AcceptanceItem, TestReport } from './types';

/** 修改時附在你的訊息最後、請 AI 一併更新驗收表的說明從這裡開始（對話紀錄裡不顯示） */
export const ACCEPTANCE_NOTE = '［FlowPilot 附註］';

/** 驗收表裡要你親自看的條目：AI 說要你測的，加上沒通過、沒測的 */
export function needsYou(a: AcceptanceItem): boolean {
  return a.needYou || a.result !== '通過';
}

/** 還欠幾項測試：要你測、還沒勾「我測過了」的，加上沒勾的其他手動項目 */
export function pendingTests(report: TestReport | null): number {
  if (!report) return 0;
  return report.acceptance.filter((a) => needsYou(a) && !a.checked).length + report.manual.filter((m) => !m.done).length;
}

/**
 * 核對驗收表有沒有漏講：實際改到的檔案裡，沒有被任何一條（或「其他改動」）提到的。
 * AI 寫的路徑可能是相對路徑或只寫到一部分，用結尾比對。
 */
export function unexplainedFiles(changed: string[], mentioned: string[]): string[] {
  const norm = (p: string) => p.trim().replace(/^\.?\//, '');
  const said = mentioned.map(norm).filter(Boolean);
  return changed.filter((file) => !said.some((m) => file === m || file.endsWith(`/${m}`) || m.endsWith(`/${file}`)));
}
