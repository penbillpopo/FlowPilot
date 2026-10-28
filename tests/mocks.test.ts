// 假資料：比對規則、寫入防護讀得到、測試說明會帶上、後端好了會偵測
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMock, pathMatches, type MockSet } from '../src/shared/mocks';
import { mockFile, readMocks, requestLogFile, writeMocks } from '../src/main/runner/runner';

const guard = createRequire(import.meta.url)('../resources/write-guard.cjs') as { findMock(set: MockSet, method: string, url: string): { path: string } | null };
const set = (rules: Partial<MockSet['rules'][number]>[], enabled = true): MockSet => ({
  enabled,
  rules: rules.map((r, i) => ({ id: String(i), method: 'GET', path: '/', status: 200, body: '{}', note: '', on: true, ...r })),
});

describe('假資料', () => {
  it('路徑比對：* 代表任何字、只看路徑不看網域和查詢參數、方法要對得上、關掉的不算', () => {
    expect(pathMatches('/api/v1/mission/*', '/api/v1/mission/list')).toBe(true);
    expect(pathMatches('/api/v1/mission/list', '/api/v1/mission/list/')).toBe(true);
    expect(pathMatches('/api/v1/mission', '/api/v1/missionx')).toBe(false);
    const s = set([{ path: '/api/v1/mission/*' }, { method: 'POST', path: '/api/v1/claim', on: false }]);
    expect(findMock(s, 'GET', 'https://sit.x.com/api/v1/mission/list?page=1')?.path).toBe('/api/v1/mission/*');
    expect(findMock(s, 'POST', 'https://sit.x.com/api/v1/mission/list')).toBeNull();
    expect(findMock(s, 'POST', 'https://sit.x.com/api/v1/claim')).toBeNull();
    expect(findMock({ ...s, enabled: false }, 'GET', 'https://sit.x.com/api/v1/mission/list')).toBeNull();
  });

  it('寫入防護用的比對跟畫面用的一樣；檔案位置從請求紀錄推得出來', () => {
    const s = set([{ path: '/api/v1/mission/*' }]);
    expect(guard.findMock(s, 'GET', 'https://sit.x.com/api/v1/mission/list')?.path).toBe('/api/v1/mission/*');
    const dir = mkdtempSync(join(tmpdir(), 'mocks-'));
    // 寫入防護用 <資料夾>/測試請求/<編號>.jsonl 推出 <資料夾>/假資料/<編號>.json
    const log = requestLogFile(dir, 7);
    expect(join(log, '..', '..', '假資料', '7.json')).toBe(mockFile(dir, 7));
    writeMocks(dir, 7, s);
    expect(readMocks(dir, 7)).toMatchObject({ enabled: true, rules: [{ path: '/api/v1/mission/*' }] });
    expect(readMocks(dir, 8)).toEqual({ enabled: false, rules: [] });
  });
});
