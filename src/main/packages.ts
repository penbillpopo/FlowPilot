// 套件有沒有裝齊：package.json 列的套件，node_modules 裡都要有。
// 為什麼不能只看 package-lock.json 有沒有變：同事可能只改 package.json、沒更新鎖定檔
// （實際發生過：ALL-14492 加了 markdown-it，鎖定檔沒跟著改，切分支時 FlowPilot 以為套件一樣就沒裝，網站編譯失敗）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** package.json 的 dependencies、devDependencies 裡，node_modules 沒有的套件 */
export function missingPackages(cwd: string): string[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return names.filter((name) => !existsSync(join(cwd, 'node_modules', name, 'package.json')));
}

/**
 * 要裝套件時的指令：鎖定檔變了就照一般的 npm install；
 * 只是缺套件（鎖定檔沒變）用 --no-save，不改 package.json 和鎖定檔，免得多出一個跟這張單無關的修改。
 */
export function installCommand(lockChanged: boolean): string {
  return lockChanged ? 'npm install' : 'npm install --no-save';
}
