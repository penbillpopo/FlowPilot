// 驗收表匯出成 CSV
import { describe, expect, it } from 'vitest';
import { acceptanceCsv } from '../src/main/acceptance-csv';

describe('驗收表匯出 CSV', () => {
  it('加 BOM（Excel 中文不亂碼）；有逗號、引號、換行的格子用引號包起來；其他部分標出類別', () => {
    const csv = acceptanceCsv({
      attention: ['Figma 沒提供'],
      acceptance: [{ no: 1, text: '不顯示 Connect your wallet', result: '沒過', note: '還是看得到, 要修', change: '只在有 SSO 時顯示', why: '預期結果第 1 條', files: ['a.html', 'a.ts'], impact: '', howToTest: '開 "Log In"', page: '/login', needYou: false, checked: false, changed: true }],
      otherChanges: [],
      manual: [{ text: '中英文切換', done: true }],
    });
    expect(csv.startsWith('﻿編號,預期結果,AI 測試結果')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toBe('1,不顯示 Connect your wallet,沒過,"還是看得到, 要修",是,,是,只在有 SSO 時顯示,預期結果第 1 條,"a.html\na.ts",,"開 ""Log In""",/login');
    expect(lines[2]).toBe('要你注意,Figma 沒提供');
    expect(lines[3]).toBe('其他要你手動測的,中英文切換,,,是,是');
  });
});
