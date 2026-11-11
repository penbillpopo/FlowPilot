import { describe, expect, it } from 'vitest';
import { compileErrors } from '../src/shared/compile-errors';

const ESC = '\x1b';
const failed = `
> platform-web@0.0.0 start
> ng serve --port 4201

${ESC}[31m✘ ${ESC}[41;31m[${ESC}[41;97mERROR${ESC}[41;31m]${ESC}[0m ${ESC}[1mTS2554: Expected 0 arguments, but got 1.${ESC}[0m [plugin angular-compiler]

    src/app/shared/components/third-auth-m8/third-auth-m8.service.ts:1161:28:
      1161 │           subscribeCallback(e);
           ╵                             ^

✘ [ERROR] TS2454: Variable 'request' is used before being assigned. [plugin angular-compiler]

    src/app/pages/login-dialog/login.service.ts:220:39:
      220 │           if (this.kycFlagPromise === request) {
          ╵                                        ~~~~~~~

Watch mode enabled. Watching for file changes...
`;

describe('本機網站的編譯錯誤', () => {
  it('抓出最近一次編譯的每個錯誤（拿掉顏色碼）', () => {
    const r = compileErrors(failed)!;
    expect(r.count).toBe(2);
    expect(r.titles).toEqual(["TS2554: Expected 0 arguments, but got 1.", "TS2454: Variable 'request' is used before being assigned."]);
    expect(r.text).toContain('third-auth-m8.service.ts:1161:28');
    expect(r.text).toContain('login.service.ts:220:39');
    expect(r.text).not.toContain('Watch mode');
    expect(r.text).not.toContain(ESC);
  });

  it('之後編譯成功就不算；重新執行指令只看新的', () => {
    expect(compileErrors(`${failed}\nApplication bundle generation complete. [2.1 seconds]\n`)).toBeNull();
    expect(compileErrors(`${failed}\n> ng serve --port 4201\n\nInitial chunk files | Names\n`)).toBeNull();
    expect(compileErrors('> ng serve\nApplication bundle generation complete.\n')).toBeNull();
  });

  it('重新編譯又印一次一樣的錯誤：只算一個', () => {
    expect(compileErrors(failed + failed.split('\n').slice(4).join('\n'))!.count).toBe(2);
  });
});
