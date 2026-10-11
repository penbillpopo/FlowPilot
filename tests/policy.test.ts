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
    expect(looksLikeQuestion('### 疑問\n無阻塞需求疑問；但依既定流程，請確認上述精簡設計是否同意我執行。')).toBe(true);
  });

  it('做完的報告', () => {
    expect(looksLikeQuestion('已完成修改，建置通過，改了 3 個檔案。')).toBe(false);
    // 報告的風險段落提到要 PM 確認，不是在問你（ALL-14324 實際誤判過）
    expect(looksLikeQuestion('### 修改內容\n- 已完成\n\n### 未完成或風險\n- 暫定維持登入前也可設定；PM 需確認是否應限制為僅登入後。\n- 天數比較語意仍需 PM／BE 定義，前端目前僅限制為正整數。')).toBe(false);
    // 前面段落有「是否」但最後已經做完
    expect(looksLikeQuestion('是否要支援複選？先照單選做。\n\n已完成修改，建置通過。')).toBe(false);
  });
});
