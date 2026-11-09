// 自動填 Jira 估時：進作戰室時，替還沒有估時的單填「原始預估值」。
// 寫法跟團隊一致（1h、2h、4h、1d、1d 4h、2d），數字大約是同事估時的一半（有 AI 幫忙）。
// 已經有估時的一律不動；只寫原始預估值，不碰其他欄位。
import { t } from '../shared/i18n';
import type { Review } from '../shared/types';
import type { JiraCredentials } from './jira';

/** 可以用的估時（小時），一天 8 小時 */
const STEPS = [1, 2, 4, 8, 12, 16];
/** 最多 2 天 */
const MAX_HOURS = 16;

/** 取最接近的一格；一樣近時取大的 */
export function snapHours(hours: number): number {
  let best = STEPS[0];
  for (const step of STEPS) if (Math.abs(step - hours) <= Math.abs(best - hours)) best = step;
  return best;
}

/** 小時 → Jira 的寫法（12 → 1d 4h） */
export function formatEstimate(hours: number): string {
  const days = Math.floor(hours / 8);
  const rest = hours % 8;
  return [days ? `${days}d` : '', rest ? `${rest}h` : ''].filter(Boolean).join(' ');
}

export interface EstimateInput {
  review: Pick<Review, 'level' | 'steps' | 'apis' | 'pages'> | null;
  /** 除了第一個以外，還要做的商戶或專案數（每個加 1 小時） */
  extraTargets: number;
  /** 合成任務的成員數（一般的單是 1）：總估時平均分給每張 */
  members: number;
}

export interface Estimate {
  /** 每張單要填的值（Jira 寫法） */
  value: string;
  hours: number;
  /** 為什麼這樣估（寫進紀錄） */
  reason: string;
}

export function estimateTicket({ review, extraTargets, members }: EstimateInput): Estimate {
  const level = review?.level ?? '一般';
  const steps = review?.steps?.length ?? 0;
  const apis = review?.apis?.length ?? 0;
  const pages = review?.pages?.length ?? 0;
  let base: number;
  let bigger: boolean;
  if (level === '小') {
    bigger = steps > 3 || pages > 1;
    base = bigger ? 2 : 1;
  } else if (level === '複雜') {
    bigger = steps >= 10 || apis >= 3 || pages >= 4;
    base = bigger ? 16 : 12;
  } else {
    bigger = steps >= 6 || apis >= 1 || pages >= 3;
    base = bigger ? 8 : 4;
  }
  const total = Math.min(MAX_HOURS, base + Math.max(0, extraTargets));
  const each = Math.max(1, snapHours(total / Math.max(1, members)));
  const parts = [
    review ? `${level}單` : '沒有審閱結果，當一般單',
    steps ? `${steps} 個步驟` : '',
    apis ? `${apis} 支 API` : '',
    pages ? `${pages} 個頁面` : '',
    extraTargets > 0 ? `另外 ${extraTargets} 個商戶或專案各加 1h` : '',
    members > 1 ? `合成任務共 ${formatEstimate(snapHours(total))}，${members} 張平分` : '',
  ].filter(Boolean);
  return { value: formatEstimate(each), hours: each, reason: parts.join(t('、')) };
}

function authHeader(credentials: JiraCredentials) {
  return `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;
}

/** 這張單現在的原始預估值（沒填是 null） */
export async function readOriginalEstimate(credentials: JiraCredentials, key: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(`${credentials.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=timetracking`, {
    headers: { Authorization: authHeader(credentials), Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(t('讀取 {key} 的估時失敗：HTTP {status}', { key, status: response.status }));
  const body = (await response.json()) as { fields?: { timetracking?: { originalEstimate?: string } } };
  return body.fields?.timetracking?.originalEstimate || null;
}

/**
 * 只在還沒有估時時填原始預估值；有值就不動。
 * 回傳 'written'（填了）或 'kept'（原本就有，回傳原本的值）。
 */
export async function fillOriginalEstimate(
  credentials: JiraCredentials,
  key: string,
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ result: 'written' } | { result: 'kept'; existing: string }> {
  const existing = await readOriginalEstimate(credentials, key, fetchImpl);
  if (existing) return { result: 'kept', existing };
  const response = await fetchImpl(`${credentials.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { Authorization: authHeader(credentials), Accept: 'application/json', 'Content-Type': 'application/json' },
    // 只送原始預估值這一個欄位
    body: JSON.stringify({ fields: { timetracking: { originalEstimate: value } } }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(t('填 {key} 的估時失敗：HTTP {status}{detail}', { key, status: response.status, detail: text ? t('（{text}）', { text: text.slice(0, 200) }) : '' }));
  }
  return { result: 'written' };
}
