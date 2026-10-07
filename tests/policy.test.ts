import { describe, expect, it } from 'vitest';
import { commandPolicy, looksLikeQuestion } from '../src/main/runner/policy';

describe('指令同意規則', () => {
  it.each([
    'git push origin ban/m1/ALL-1',
    '/bin/zsh -lc "git push"',
    'git commit -m "x"',
    'git checkout master-1',
    'git switch -c other',
    'git reset --hard HEAD',
    'git clean -fd',
    'git branch -D ban/m1/ALL-1',
    'git checkout -- .',
    'git restore .',
    'git stash',
    'rm -rf node_modules',
    'az repos pr create --title x',
  ])('要問你：%s', (command) => {
    expect(commandPolicy(command).ask).toBe(true);
  });

  it.each([
    'git status',
    'git diff master-1...HEAD',
    'git log --oneline -5',
    'git checkout -- src/app/a.ts',
    'git restore src/app/a.ts',
    'git branch --show-current',
    'npm run build',
    'npm install',
    'rg "foo" src',
    'rm src/old.ts',
  ])('自動同意：%s', (command) => {
    expect(commandPolicy(command).ask).toBe(false);
  });
});

describe('最後的回覆是不是在問問題', () => {
  it('問句或請你確認', () => {
    expect(looksLikeQuestion('測試計畫如下……\n請確認後我再開始執行。')).toBe(true);
    expect(looksLikeQuestion('要用 SIT 還是 UAT？')).toBe(true);
  });

  it('做完的報告', () => {
    expect(looksLikeQuestion('已完成修改，建置通過，改了 3 個檔案。')).toBe(false);
  });
});
