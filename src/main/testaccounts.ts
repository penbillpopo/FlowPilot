// 瀏覽器測試用的帳號：一律用 ~/.codex/local-test-configs/{專案}.playwright.json（測試技能原本就讀這裡）。
// 檔案裡的 project 欄位不可靠（有標錯的），一律看檔名對應專案。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './environment';

export interface TestAccount {
  username: string;
  password: string;
  /** 登入畫面要 OTP 時填這個 */
  otp?: string;
  /** 其他登入相關的說明（2FA、驗證碼、IP 白名單） */
  notes: string[];
}

const clean = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== '無' ? v.trim() : undefined);

function fromEntry(entry: Record<string, unknown> | undefined): TestAccount | null {
  const username = clean(entry?.username);
  // 密碼可能還沒填（先有帳號、密碼之後補）：照樣回傳帳號，password 是空字串
  const password = clean(entry?.password) ?? clean(entry?.passwordSource) ?? '';
  if (!entry || !username) return null;
  const notes = (['twoFactor', 'captcha', 'ipAllowlist'] as const).flatMap((k) => (clean(entry[k]) ? [`${k}：${clean(entry[k])}`] : []));
  return { username, password, otp: clean(entry.otp), notes };
}

/** 從帳號檔找出這個專案（商戶）、這個環境的帳號；找不到回傳 null */
export function accountFromConfig(config: any, merchant: number | null, env: Env): TestAccount | null {
  const list: any[] = Array.isArray(config?.environments) ? config.environments : [];
  // PlatformWeb：依商戶，再分 sit／uat
  const byMerchant = list.find((e) => merchant !== null && Number(e?.merchant) === merchant);
  if (byMerchant) return fromEntry(byMerchant[env]);
  // 兩個 Admin：依環境
  return fromEntry(list.find((e) => String(e?.environment ?? '').toLowerCase() === env));
}

export function configFile(dir: string, project: string): string {
  return join(dir, `${project}.playwright.json`);
}

/** 這個專案（商戶）、這個環境測試要用的帳號；帳號檔沒有就是 null */
export function resolveAccount(dir: string, project: string, merchant: number | null, env: Env): TestAccount | null {
  const file = configFile(dir, project);
  if (!existsSync(file)) return null;
  try {
    return accountFromConfig(JSON.parse(readFileSync(file, 'utf8')), merchant, env);
  } catch {
    return null;
  }
}

/**
 * 寫一份這次測試用的登入資料給 AI 讀（放在 FlowPilot 自己的資料夾，不在專案裡）。
 * 密碼不寫進給 AI 的指示，只告訴它檔案在哪。
 */
export function writeAccountFile(dir: string, itemId: number, data: { project: string; merchant: number | null; environment: Env; url: string; account: TestAccount }): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${itemId}.json`);
  const { account } = data;
  writeFileSync(
    file,
    JSON.stringify(
      {
        project: data.project,
        merchant: data.merchant,
        environment: data.environment.toUpperCase(),
        url: data.url,
        username: account.username,
        password: account.password,
        otp: account.otp ?? null,
        notes: account.notes,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return file;
}
