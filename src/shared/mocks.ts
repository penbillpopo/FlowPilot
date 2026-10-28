// 假資料（後端還沒好時，前端先用假的 API 回應測試）：存在 FlowPilot 的資料夾，不寫進專案程式碼，只在 FlowPilot 開的瀏覽器裡生效。
// 寫入防護（resources/write-guard.cjs）和「用假資料打開」的視窗都用這裡的比對規則。

export interface MockRule {
  id: string;
  /** GET、POST…；空字串是不分方法 */
  method: string;
  /** 網址路徑，可以用 * 代表任何字（例如 /api/v1/mission/*） */
  path: string;
  status: number;
  /** 回應內容（JSON 字串） */
  body: string;
  /** 一句話：這個 API 在做什麼、這筆假資料是什麼情境 */
  note: string;
  on: boolean;
}

export interface MockSet {
  /** 總開關 */
  enabled: boolean;
  rules: MockRule[];
  /** 後端已經好了的 API（定時檢查，好了就提醒你拿掉假資料重測） */
  ready?: string[];
}

export const EMPTY_MOCKS: MockSet = { enabled: false, rules: [] };

/** 路徑比對：* 代表任何字；只比路徑，不看網域和查詢參數 */
export function pathMatches(pattern: string, pathname: string): boolean {
  const re = new RegExp('^' + pattern.trim().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '/?$', 'i');
  return re.test(pathname);
}

/** 這個請求要回哪一筆假資料（沒開、沒對到就是 null） */
export function findMock(set: MockSet | null, method: string, url: string): MockRule | null {
  if (!set?.enabled) return null;
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  return set.rules.find((r) => r.on && (!r.method || r.method.toUpperCase() === method.toUpperCase()) && pathMatches(r.path, pathname)) ?? null;
}
