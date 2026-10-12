// 測試瀏覽器的寫入防護：哪些請求放行、哪些擋下
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { decide, shouldRecord } = createRequire(import.meta.url)('../resources/write-guard.cjs') as { decide(method: string, url: string): string; shouldRecord(url: string): boolean };
const u = (path: string) => `http://localhost:4300${path}`;

describe('寫入防護', () => {
  it('只讀取的、登入的、查詢的放行', () => {
    expect(decide('GET', u('/api/resource/popup/deletepopup'))).toBe('pass'); // GET 不會改資料
    expect(decide('POST', u('/api/v1/admin/auth/login'))).toBe('login');
    expect(decide('POST', u('/api/auth/verifyotp'))).toBe('login');
    expect(decide('POST', u('/api/resource/popup/getpopuplist'))).toBe('read');
    expect(decide('POST', u('/api/member/exportlist'))).toBe('read');
    expect(decide('POST', u('/api/resource/upload/uploadimage'))).toBe('upload'); // 上傳檔案放行
    expect(decide('PUT', u('/api/resource/uploadimage'))).toBe('block'); // 但 PUT 還是擋
  });

  it('登入流程的其他步驟放行（寄驗證信、兩步驟驗證）；同樣在 auth 底下的改密碼、綁定還是擋', () => {
    const web = (path: string) => `https://uat8-newplatform.mxsyl.com${path}`;
    expect(decide('POST', web('/v1/member/auth/loginbyemail'))).toBe('login');
    expect(decide('POST', web('/v1/member/auth/sendemailverify'))).toBe('login');
    expect(decide('POST', web('/v1/member/auth/verify2fa'))).toBe('login');
    expect(decide('POST', web('/v1/member/auth/resetpassword'))).toBe('block');
    expect(decide('POST', web('/v1/member/auth/bindphonecode'))).toBe('block');
    expect(decide('POST', web('/v1/member/sendemailverify'))).toBe('block'); // 不在 auth 底下就照一般規則
    expect(decide('POST', web('/v1/game/gamemultiplelabel'))).toBe('read'); // 查遊戲標籤
  });

  it('會改資料的擋下：先看有沒有改資料的字，再看查詢的字；看不出來的也擋', () => {
    expect(decide('POST', u('/api/resource/popup/addpopup'))).toBe('block');
    expect(decide('POST', u('/api/x/updateBudget'))).toBe('block'); // 有 get 但其實是 update
    expect(decide('POST', u('/api/auth/updatepassword'))).toBe('block'); // 在 auth 底下但會改資料
    expect(decide('POST', u('/api/x/somethingodd'))).toBe('block');
    expect(decide('PUT', u('/api/resource/popup/getlist'))).toBe('block'); // PUT、PATCH、DELETE 一律擋
    expect(decide('DELETE', u('/api/resource/popup/getlist'))).toBe('block');
    expect(decide('PATCH', u('/api/x/list'))).toBe('block');
  });

  it('只記錄送到專案後端的請求（其他網站的寫入照樣擋，但不記）', () => {
    process.env.FLOWPILOT_API_HOSTS = '20.198.251.181,uat-admin-api.mxsyl.com:5012';
    expect(shouldRecord('http://20.198.251.181/api/v1/resource/popup/addpopup')).toBe(true);
    expect(shouldRecord('http://uat-admin-api.mxsyl.com:5012/api/v1/x')).toBe(true);
    expect(shouldRecord('https://errors.example.com/api/9/envelope/')).toBe(false);
    process.env.FLOWPILOT_API_HOSTS = '';
    expect(shouldRecord('https://errors.example.com/api/9/envelope/')).toBe(true); // 不知道後端在哪就全部記
  });
});
