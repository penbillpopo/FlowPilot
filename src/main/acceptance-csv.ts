// 驗收表匯出成 CSV（Excel 打得開：加 BOM，中文不會亂碼）
import { t } from '../shared/i18n';
import { needsYou } from '../shared/acceptance';
import type { TestReport } from '../shared/types';

// i18n-keys：顯示時才翻
const HEADER = ['編號', '預期結果', 'AI 測試結果', 'AI 測試說明', '要你測', '我測過了', '有變動', '改了什麼', '為什麼', '改在哪些檔案', '也影響', '怎麼測', '頁面'];

/** 一格：有逗號、引號、換行就用引號包起來，引號重複一次 */
function cell(value: string | number | boolean | undefined): string {
  const text = value === undefined ? '' : typeof value === 'boolean' ? (value ? t('是') : '') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function acceptanceCsv(report: TestReport): string {
  const rows: (string | number | boolean | undefined)[][] = [HEADER.map((h) => t(h))];
  for (const a of report.acceptance) {
    rows.push([a.no, a.text, a.result ? t(a.result) : a.result, a.note, needsYou(a), a.checked, a.changed, a.change, a.why, a.files.join('\n'), a.impact, a.howToTest, a.page]);
  }
  // 驗收表其他的部分，第一欄標出是哪一類
  for (const note of report.attention) rows.push([t('要你注意'), note]);
  for (const c of report.otherChanges) rows.push([t('其他也改到的'), c.change, '', '', '', '', '', c.change, c.why, c.files.join('\n'), c.impact]);
  for (const m of report.manual) rows.push([t('其他要你手動測的'), m.text, '', '', true, m.done]);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
