import { describe, expect, it } from 'vitest';
import { commandPolicy, looksLikeQuestion, parseTestReport, parseTestResult } from '../src/main/runner/policy';

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

describe('瀏覽器測試的結果', () => {
  it('讀最後一次出現的「測試結果：…」，括號裡是原因', () => {
    expect(parseTestResult('報告…\n測試結果：通過')).toEqual({ kind: 'passed' });
    expect(parseTestResult('測試結果：部分通過（匯出沒測）')).toEqual({ kind: 'partial', reason: '匯出沒測' });
    expect(parseTestResult('測試結果: 沒測成(登入失敗)')).toEqual({ kind: 'failed', reason: '登入失敗' });
    expect(parseTestResult('格式說明：測試結果：通過\n…\n測試結果：沒測成（網站打不開）')).toEqual({ kind: 'failed', reason: '網站打不開' });
    expect(parseTestResult('目前 Playwright 驗證通過。')).toEqual({ kind: 'unknown' });
  });
});

describe('測試報告', () => {
  const block = (json: object) => '報告…\n```flowpilot-test\n' + JSON.stringify(json) + '\n```\n測試結果：部分通過（有些沒測）';
  it('讀最後一段，結果不認得的當成沒測；重測後同樣的手動項目保留勾選', () => {
    const first = parseTestReport(block({ acceptance: [{ no: 1, text: '選存款次數時只顯示次數框', result: '通過', note: '畫面正確' }, { no: 2, text: 'X', result: '怪怪的' }], manual: ['存檔後列表多一筆', '中英文切換'] }));
    expect(first?.acceptance.map(({ no, text, result, note }) => ({ no, text, result, note }))).toEqual([
      { no: 1, text: '選存款次數時只顯示次數框', result: '通過', note: '畫面正確' },
      { no: 2, text: 'X', result: '沒測', note: '' },
    ]);
    expect(first?.manual).toEqual([{ text: '存檔後列表多一筆', done: false }, { text: '中英文切換', done: false }]);
    expect(first).toMatchObject({ attention: [], otherChanges: [] });
    const checked = { ...first!, manual: [{ text: '存檔後列表多一筆', done: true }, { text: '中英文切換', done: false }] };
    expect(parseTestReport(block({ acceptance: [], manual: ['存檔後列表多一筆', '新的項目'] }), checked)?.manual).toEqual([{ text: '存檔後列表多一筆', done: true }, { text: '新的項目', done: false }]);
  });

  it('驗收表：讀出改了什麼、為什麼、改在哪；影響寫「沒有」當成空的', () => {
    const report = parseTestReport(block({
      attention: ['Jira 沒說要不要記住篩選，我做成不記住'],
      acceptance: [{ no: 1, text: '新增狀態篩選', result: '通過', note: '', change: '列表上方多一個下拉選單', why: '預期結果第 1 條', files: ['src/app/order/list.component.ts'], impact: '沒有', howToTest: '商戶 8 → 訂單管理 → 選已取消', page: '/order/list', needYou: true }],
      otherChanges: [{ change: '共用日期元件加參數', why: '要傳預設值', files: ['src/shared/date.ts'], impact: '報表' }, { change: '' }],
    }));
    expect(report?.attention).toEqual(['Jira 沒說要不要記住篩選，我做成不記住']);
    expect(report?.acceptance[0]).toMatchObject({ change: '列表上方多一個下拉選單', files: ['src/app/order/list.component.ts'], impact: '', page: '/order/list', needYou: true, checked: false, changed: false });
    expect(report?.otherChanges).toEqual([{ change: '共用日期元件加參數', why: '要傳預設值', files: ['src/shared/date.ts'], impact: '報表' }]);
  });

  it('修改後：沒變的條目保留「我測過了」，有變的標成有變動並取消勾選', () => {
    const item = (no: number, change: string) => ({ no, text: `第 ${no} 條`, result: '通過', change, files: ['a.ts'], needYou: true });
    const first = parseTestReport(block({ acceptance: [item(1, '原本'), item(2, '原本')] }))!;
    const checked = { ...first, acceptance: first.acceptance.map((a) => ({ ...a, checked: true })) };
    const next = parseTestReport(block({ acceptance: [item(1, '原本'), item(2, '改過了')] }), checked)!;
    expect(next.acceptance.map((a) => [a.checked, a.changed])).toEqual([[true, false], [false, true]]);
  });

  it('只寫有變的部分（update）：沒寫到的條目沿用上一版、保留勾選，其他欄位接在後面', () => {
    const item = (no: number, change: string) => ({ no, text: `第 ${no} 條`, result: '通過', change, files: ['a.ts'], needYou: true });
    const first = parseTestReport(block({ acceptance: [item(1, '原本'), item(2, '原本'), item(3, '原本')], manual: ['舊的手動項目'], attention: ['舊的注意'] }))!;
    const checked = { ...first, acceptance: first.acceptance.map((a) => ({ ...a, checked: true })) };
    const next = parseTestReport(block({ update: true, acceptance: [item(2, '改過了'), item(4, '新的')], manual: ['新的手動項目'], otherChanges: [{ change: '順便修了樣式', files: ['b.scss'] }] }), checked)!;
    expect(next.acceptance.map((a) => [a.no, a.change, a.checked, a.changed])).toEqual([
      [1, '原本', true, false],
      [2, '改過了', false, true],
      [3, '原本', true, false],
      [4, '新的', false, true],
    ]);
    expect(next.manual.map((m) => m.text)).toEqual(['舊的手動項目', '新的手動項目']);
    expect(next.attention).toEqual(['舊的注意']);
    expect(next.otherChanges.map((c) => c.change)).toEqual(['順便修了樣式']);
  });

  it('驗收卡片的欄位：三行步驟、AI 整理標記、截圖檔名（帶路徑的不收）', () => {
    const r = parseTestReport(block({ acceptance: [
      { no: 1, text: 'Jira 原文', open: '打開個人資料頁', act: '點設定', expect: '看到隱身模式是開的', shot: 'ac-ALL-1-1.png', fromAi: true, result: '通過', needYou: false },
      { no: 2, text: 'B', shot: '../../secret.png', result: '沒測', needYou: true },
    ] }))!;
    expect(r.acceptance[0]).toMatchObject({ open: '打開個人資料頁', act: '點設定', expect: '看到隱身模式是開的', shot: 'ac-ALL-1-1.png', fromAi: true });
    expect(r.acceptance[1].shot).toBeUndefined();
    expect(r.acceptance[1].fromAi).toBeUndefined();
  });

  it('沒有報告或格式不對就是 null', () => {
    expect(parseTestReport('測試結果：通過')).toBeNull();
    expect(parseTestReport('```flowpilot-test\n{壞掉的 JSON\n```')).toBeNull();
  });
});

describe('rebase 衝突讓 AI 自己解', () => {
  it('git rebase --continue 不用問；其他 rebase、merge 還是要問', () => {
    expect(commandPolicy('GIT_EDITOR=true git rebase --continue').ask).toBe(false);
    expect(commandPolicy('git rebase origin/master-1').ask).toBe(true);
    expect(commandPolicy('git rebase --continue && git push -f').ask).toBe(true);
  });
});

describe('驗收表核對', () => {
  it('改到但沒被提到的檔案挑出來；路徑寫一部分也認得', async () => {
    const { unexplainedFiles } = await import('../src/shared/acceptance');
    expect(unexplainedFiles(['src/app/a.ts', 'src/app/b.html', 'src/shared/c.ts'], ['app/a.ts', './src/app/b.html'])).toEqual(['src/shared/c.ts']);
  });
});
