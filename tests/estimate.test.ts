import { describe, expect, it } from 'vitest';
import { estimateTicket, fillOriginalEstimate, formatEstimate, snapHours } from '../src/main/estimate';

const creds = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', token: 'tok' };
const review = (level: '小' | '一般' | '複雜', steps = 0, apis = 0, pages = 0) => ({
  level,
  steps: Array(steps).fill('s'),
  apis: Array(apis).fill('a'),
  pages: Array(pages).fill('p'),
});

describe('估時', () => {
  it('寫法跟團隊一致', () => {
    expect([1, 2, 4, 8, 12, 16].map(formatEstimate)).toEqual(['1h', '2h', '4h', '1d', '1d 4h', '2d']);
    expect(snapHours(3)).toBe(4);
    expect(snapHours(5)).toBe(4);
    expect(snapHours(6)).toBe(8);
    expect(snapHours(0.4)).toBe(1);
  });

  it('依難度與內容多寡', () => {
    expect(estimateTicket({ review: review('小'), extraTargets: 0, members: 1 }).value).toBe('1h');
    expect(estimateTicket({ review: review('小', 5), extraTargets: 0, members: 1 }).value).toBe('2h');
    expect(estimateTicket({ review: review('一般', 3), extraTargets: 0, members: 1 }).value).toBe('4h');
    expect(estimateTicket({ review: review('一般', 3, 1), extraTargets: 0, members: 1 }).value).toBe('1d');
    expect(estimateTicket({ review: review('複雜', 5), extraTargets: 0, members: 1 }).value).toBe('1d 4h');
    expect(estimateTicket({ review: review('複雜', 12), extraTargets: 0, members: 1 }).value).toBe('2d');
  });

  it('多商戶每個加 1h，最多 2d；合成任務平分', () => {
    expect(estimateTicket({ review: review('小'), extraTargets: 1, members: 1 }).value).toBe('2h');
    expect(estimateTicket({ review: review('複雜', 12), extraTargets: 4, members: 1 }).value).toBe('2d');
    const group = estimateTicket({ review: review('一般', 8), extraTargets: 0, members: 2 });
    expect(group.value).toBe('4h');
    expect(group.reason).toContain('2 張平分');
  });

  it('已經有估時就不動，沒有才只寫原始預估值', async () => {
    const calls: { method?: string; body?: string }[] = [];
    const fetchWith = (existing: string | undefined) =>
      (async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body as string });
        if (init?.method === 'PUT') return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ fields: { timetracking: existing ? { originalEstimate: existing } : {} } }));
      }) as typeof fetch;
    expect(await fillOriginalEstimate(creds, 'ALL-1', '4h', fetchWith('1d'))).toEqual({ result: 'kept', existing: '1d' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(await fillOriginalEstimate(creds, 'ALL-1', '4h', fetchWith(undefined))).toEqual({ result: 'written' });
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ fields: { timetracking: { originalEstimate: '4h' } } });
  });
});
