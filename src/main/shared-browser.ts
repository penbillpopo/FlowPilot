// 你和 AI 共用的瀏覽器：你平常用的 Chrome。AI 透過 Playwright 官方的擴充功能（Playwright Extension）接上，
// 第一次接上時 Chrome 會跳出頁面讓你選要給 AI 的分頁；沿用你的登入狀態。
// 擴充功能：https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm
import { t } from '../shared/i18n';
import { execFile } from 'node:child_process';

export const PLAYWRIGHT_EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';

/** 用 Chrome 打開（不管預設瀏覽器是哪個，AI 只接得上 Chrome） */
export function openInChrome(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Google Chrome', url], (error) => (error ? reject(new Error(t('打不開 Chrome：{error}', { error: error.message }))) : resolve()));
  });
}
