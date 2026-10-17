// 介面語言：中文（原本的樣子）或英文。程式裡照樣寫中文原文，英文版用對照表查（src/shared/locales/en）。
// 為什麼用中文當 key：程式碼照樣好讀、中文版一個字都不會被改到；漏翻的話 tests/i18n.test.ts 會抓出來。
import { EN } from './locales/en';
import JIRA_EN from './locales/en/jira';

export type Lang = 'zh' | 'en';

let current: Lang = 'zh';

export const getLang = (): Lang => current;

export function setLang(lang: Lang) {
  current = lang === 'en' ? 'en' : 'zh';
}

/**
 * 翻譯給人看的文字：中文原文當 key，英文版查對照表（查不到就顯示原文）。
 * 有變數的寫成 t('已記下 {count} 條', { count })，不要用 `${}` 組字串（英文的語序可能不一樣）。
 */
export function t(zh: string, params?: Record<string, string | number>): string {
  const text = current === 'en' ? (EN[zh] ?? zh) : zh;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** 不翻的中文：給 AI 看的指示、用來比對 AI 回覆的關鍵字。標起來讓檢查知道是故意的 */
export const zhOnly = (text: string): string => text;

/**
 * 這段固定用中文產生（例如要給團隊、PM 看的 PR 說明、Jira 留言）：不管介面語言，裡面的 t() 都回中文。
 */
export function inChinese<T>(build: () => T): T {
  const before = current;
  current = 'zh';
  try {
    return build();
  } finally {
    current = before;
  }
}

/** Jira 的狀態、類型名稱（資料）：英文介面時翻成英文顯示，查不到就照原樣；只用在顯示，傳給 Jira 的值不要用它 */
export function jiraName(name: string): string {
  return current === 'en' ? (JIRA_EN[name] ?? name) : name;
}

/** 設定檔裡專案的前台／後台標籤（例如「後台（GoGaming）」）：英文介面時翻成英文顯示，設定檔不用改 */
const SIDE_EN: Record<string, string> = { 前台: 'Frontend', 後台: 'Backend', 玩家端: 'player site' };
export function sideName(side: string): string {
  if (current !== 'en') return side;
  return side.replace(/前台|後台|玩家端/g, (word) => SIDE_EN[word]).replace(/（/g, ' (').replace(/）/g, ')');
}
