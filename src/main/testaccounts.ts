// 瀏覽器測試用的帳號：平常沿用 ~/.codex/local-test-configs/{專案}.playwright.json（測試技能原本就讀這裡）；
// 你在工作台為某張單指定的帳號優先，只限那張單。
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
  source: '這張單指定' | '帳號檔';
}

const clean = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== '無' ? v.trim() : undefined);

function fromEntry(entry: Record<string, unknown> | undefined): Omit<TestAccount, 'source'> | null {
  const username = clean(entry?.username);
  const password = clean(entry?.password) ?? clean(entry?.passwordSource);
  if (!entry || !username || !password) return null;
  const notes = (['twoFactor', 'captcha', 'ipAllowlist'] as const).flatMap((k) => (clean(entry[k]) ? [`${k}：${clean(entry[k])}`] : []));
  return { username, password, otp: clean(entry.otp), notes };
}

/** 從帳號檔找出這個專案（商戶）、這個環境的帳號；找不到回傳 null */
export function accountFromConfig(config: any, merchant: number | null, env: Env): Omit<TestAccount, 'source'> | null {
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

/** 這張單這次測試要用的帳號：有指定就用指定的，否則看帳號檔 */
export function resolveAccount(
  dir: string,
  project: string,
  merchant: number | null,
  env: Env,
  override: { username: string; password: string } | null,
): TestAccount | null {
  if (override?.username && override.password) return { username: override.username, password: override.password, notes: [], source: '這張單指定', ...otpOf(dir, project, merchant, env) };
  const file = configFile(dir, project);
  if (!existsSync(file)) return null;
  try {
    const found = accountFromConfig(JSON.parse(readFileSync(file, 'utf8')), merchant, env);
    return found ? { ...found, source: '帳號檔' } : null;
  } catch {
    return null;
  }
}

/** 指定帳號時，OTP 還是沿用帳號檔裡同環境的設定（同一個環境的 OTP 通常一樣） */
function otpOf(dir: string, project: string, merchant: number | null, env: Env): { otp?: string } {
  try {
    const otp = accountFromConfig(JSON.parse(readFileSync(configFile(dir, project), 'utf8')), merchant, env)?.otp;
    return otp ? { otp } : {};
  } catch {
    return {};
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
