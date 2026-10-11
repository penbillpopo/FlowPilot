import { describe, expect, it } from 'vitest';
import { detectEnvironment, switchEnvironment } from '../src/main/environment';

const WEB = `import { commonEnvironment } from './environment.common';

// sit分支本地调试使用这个，注释另一个
const apiUrl = 'https://sit8-newplatform.mxsyl.com';
const tenant = '8';
// uat分支本地调试使用这个，注释另一个
// const apiUrl = 'https://uat8-newplatform.mxsyl.com';
// const tenant = '8';

const production = false;
`;

const ADMIN = `export const environment = {
  env: 'sit',

  /** SIT */
  apiUrl: 'http://20.198.251.181/api/v1',
  /** UAT */
  // apiUrl: 'http://uat-admin-api.mxsyl.com:5012/api/v1',

  wsHeartbeatTime: 5_000, // 心跳时间
};
`;

describe('environment.ts 切換', () => {
  it('PlatformWeb：偵測與切換，只動標記下的兩行', () => {
    expect(detectEnvironment(WEB)).toBe('sit');
    const uat = switchEnvironment(WEB, 'uat');
    expect(detectEnvironment(uat)).toBe('uat');
    expect(uat).toContain("// const apiUrl = 'https://sit8-newplatform.mxsyl.com';");
    expect(uat).toContain("const tenant = '8';\n\nconst production");
    expect(uat).toContain("\nconst apiUrl = 'https://uat8-newplatform.mxsyl.com';");
    const changed = uat.split('\n').filter((l, i) => l !== WEB.split('\n')[i]);
    expect(changed).toHaveLength(4);
    expect(switchEnvironment(uat, 'sit')).toBe(WEB);
  });

  it('Admin：保留縮排，不碰 env 那行', () => {
    expect(detectEnvironment(ADMIN)).toBe('sit');
    const uat = switchEnvironment(ADMIN, 'uat');
    expect(uat).toContain("  // apiUrl: 'http://20.198.251.181/api/v1',");
    expect(uat).toContain("  apiUrl: 'http://uat-admin-api.mxsyl.com:5012/api/v1',");
    expect(uat).toContain("  env: 'sit',");
    expect(switchEnvironment(uat, 'sit')).toBe(ADMIN);
  });

  it('已經是目標環境就不變；兩組都開著算 mixed；沒有標記就是 null', () => {
    expect(switchEnvironment(WEB, 'sit')).toBe(WEB);
    expect(detectEnvironment(WEB.replace('// const apiUrl', 'const apiUrl'))).toBe('mixed');
    expect(detectEnvironment('const a = 1;\n')).toBeNull();
    expect(() => switchEnvironment('const a = 1;\n', 'uat')).toThrow();
  });

  it('標記後面沒有空行也只動對應的設定行，不會把後面的程式碼註解掉', () => {
    const tight = `export const environment = {
  /** SIT */
  apiUrl: 'http://sit/api',
  /** UAT */
  // apiUrl: 'http://uat/api',
  wsHeartbeatTime: 5_000,
};
`;
    expect(detectEnvironment(tight)).toBe('sit');
    const uat = switchEnvironment(tight, 'uat');
    expect(uat).toContain("  // apiUrl: 'http://sit/api',");
    expect(uat).toContain("  apiUrl: 'http://uat/api',\n  wsHeartbeatTime: 5_000,\n};");
    expect(switchEnvironment(uat, 'sit')).toBe(tight);
  });
});
