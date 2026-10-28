// 規格流程：寫規格 → 沒看過的 AI 審查 → 處理意見；做完後比對的處理結果。用假的 Codex，不會啟動真正的 AI。
import { describe, expect, it } from 'vitest';
import type { CodexRpc, RpcMessage } from '../src/main/codex/rpc';
import { applySpecReplies, specNextStep, buildReviewerPrompt, buildSpecPrompt, generateSpec, resolveSchema, reviewerSchema, SPEC_REVIEWERS, specBrief, specSchema, withSpecQuestions } from '../src/main/planner/spec';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../src/main/settings';
import type { Review, SpecCheck } from '../src/shared/types';
import { specItemsForYou, wantsSpec } from '../src/shared/types';

const settings = parseSettings(DEFAULT_SETTINGS_YAML);
settings.folders = [{ name: 'PlatformAdmin', path: '/work/PlatformAdmin', project: 'PlatformAdmin' }];

function review(patch: Partial<Review> = {}): Review {
  return {
    ticketKey: 'ALL-1', entries: [{ project: 'PlatformAdmin', merchants: [], sourceMerchant: null, reason: '' }], prTitle: 'feat(ALL-1) x', reason: '', summary: ['POA 通過的資料要顯示'],
    resources: [], level: '複雜', codeChecked: true, issues: [], discussion: [], reviewedAt: '2026-10-29T00:00:00.000Z',
    acceptance: ['會員詳情的驗證中級頁面應顯示已通過的 POA 認證資料'],
    snapshot: [{ key: 'ALL-1', summary: '後台會員管理未記錄POA認證通過的資料', description: '前台POA送出審核 > 後台手動通過 > 中級頁面沒有資料', comments: [], attachments: [], takenAt: '' }],
    ...patch,
  };
}

/** 假的 Codex：照問的格式回答；記下每一輪問了什麼、在哪段對話 */
function fakeCodex(answer: (schema: object, prompt: string) => unknown) {
  const listeners: ((m: RpcMessage) => void)[] = [];
  const turns: { threadId: string; prompt: string; schema: object; keep: boolean }[] = [];
  const kept = new Set<string>();
  let n = 0;
  const codex = {
    on: (l: (m: RpcMessage) => void) => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)),
    start: async () => {},
    reply: () => {},
    request: async (method: string, params: any) => {
      if (method === 'skills/list') return { data: [] };
      if (method === 'thread/start') {
        const id = `th-${++n}`;
        if (!params.ephemeral) kept.add(id);
        return { thread: { id } };
      }
      if (method === 'turn/start') {
        const prompt = params.input[0].text;
        turns.push({ threadId: params.threadId, prompt, schema: params.outputSchema, keep: kept.has(params.threadId) });
        const value = answer(params.outputSchema, prompt);
        const text = value === undefined ? '格式壞掉的回覆' : JSON.stringify(value);
        setTimeout(() => {
          listeners.forEach((l) => l({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text } } }));
          listeners.forEach((l) => l({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } }));
        }, 1);
        return { turn: { id: `turn-${n}` } };
      }
      return {};
    },
  } as unknown as CodexRpc;
  return { codex, turns };
}

function memoryReview(initial: Review) {
  let saved = initial;
  return {
    get: () => saved,
    set: (r: Review) => (saved = r),
    updateReview: (_key: string, change: (r: Review) => Review | null) => {
      const next = change(saved);
      if (next) saved = next;
      return next;
    },
  };
}

describe('規格流程', () => {
  it('複雜的單預設要走；你在檢查計畫改過的為準', () => {
    expect(wantsSpec(review())).toBe(true);
    expect(wantsSpec(review({ level: '一般' }))).toBe(false);
    expect(wantsSpec(review({ level: '一般', checks: { figma: { need: false, reason: '' }, codeReview: { need: false, reason: '' }, designCompare: { need: false, reason: '' }, spec: { need: true, reason: '' } } }))).toBe(true);
    expect(wantsSpec(review({ checks: { figma: { need: false, reason: '' }, codeReview: { need: false, reason: '' }, designCompare: { need: false, reason: '' }, spec: { need: false, reason: '' } } }))).toBe(false);
    expect(wantsSpec(null)).toBe(false);
  });

  it('寫規格的指示：不准發明後端、不知道的寫成待確認問題、附上單的原文和要讀的分支', () => {
    const prompt = buildSpecPrompt(review(), settings);
    expect(prompt).toContain('不准自己設計');
    expect(prompt).toContain('待確認問題');
    expect(prompt).toContain('前台POA送出審核');
    expect(prompt).toContain('/work/PlatformAdmin');
    expect(prompt).toContain('origin/version/0.0.1');
    expect(prompt).toContain('不要寫自動化測試計畫');
  });

  it('審查角色用 EGM 的原文，看不到單和需求分析，只有規格和程式碼位置', () => {
    const prompt = buildReviewerPrompt(SPEC_REVIEWERS[0], '# 規格內容', '- PlatformAdmin：/work/PlatformAdmin');
    expect(prompt).toContain('Skeptical Architect');
    expect(prompt).toContain('Zoom Out Standard');
    expect(prompt).toContain('# 規格內容');
    expect(prompt).toContain('invented');
    expect(prompt).not.toContain('前台POA送出審核');
  });

  it('整個流程：寫規格 → 四個角色在全新對話審 → 回到寫規格的對話處理意見；要你決定的變成問題', async () => {
    const mem = memoryReview(review({ issues: [{ id: 'old', type: '需求不明確', importance: '一般', title: '舊問題', detail: '', quote: '', from: 'ALL-1', suggestion: '', status: 'answered', answer: '照做' }] }));
    const { codex, turns } = fakeCodex((schema) => {
      if (schema === specSchema) return { markdown: '# 規格 v1\n只看 POA 圖片' };
      if (schema === reviewerSchema) return { findings: [{ severity: 'Blocker', scope: '做法', text: '沒說 POA 要已通過才顯示，待審的也會顯示' }] };
      if (schema === resolveSchema) return { items: [{ no: 1, decision: 'fix', note: '加上狀態 S' }, { no: 2, decision: 'ask', note: '問第 1 題' }, { no: 3, decision: 'contest', note: '程式已處理' }], questions: [{ title: '被拒絕的 POA 要不要顯示？', detail: '影響顯示條件', suggestion: '不顯示' }], markdown: '# 規格 v2\n只顯示狀態 S 的 POA' };
      throw new Error('沒想到的問題');
    });
    await generateSpec({ codex, settings: () => settings, cwd: '/data', updateReview: mem.updateReview, log: () => {} }, 'ALL-1');

    // 第一輪寫規格（保留對話）；四個審查各自一段全新的對話，看不到單的原文；處理意見回到寫規格的那段
    expect(turns[0]).toMatchObject({ schema: specSchema, keep: true });
    const reviews = turns.filter((x) => x.schema === reviewerSchema);
    expect(reviews).toHaveLength(4);
    expect(new Set(reviews.map((x) => x.threadId)).size).toBe(4);
    expect(reviews.every((x) => x.threadId !== turns[0].threadId && !x.keep && x.prompt.includes('# 規格 v1') && !x.prompt.includes('前台POA送出審核'))).toBe(true);
    const resolve = turns.find((x) => x.schema === resolveSchema)!;
    expect(resolve.threadId).toBe(turns[0].threadId);
    expect(resolve.prompt).toContain('1. [zoomOut｜Blocker]');

    const spec = mem.get().spec!;
    expect(spec).toMatchObject({ status: 'done', step: '', markdown: '# 規格 v2\n只顯示狀態 S 的 POA', failedReviewers: 0, reviewedAt: '2026-10-29T00:00:00.000Z' });
    expect(spec.findings.map((f) => f.decision)).toEqual(['fix', 'ask', 'contest', 'fix']); // 沒寫處理結果的當成照改
    expect(mem.get().issues).toHaveLength(2);
    expect(mem.get().issues[1]).toMatchObject({ title: '被拒絕的 POA 要不要顯示？', suggestion: '不顯示', status: 'open', importance: '重要', fromSpec: true });
    // 開發的 AI 拿到處理過的規格
    expect(specBrief(mem.get())).toContain('# 規格 v2');
  });

  it('中途重新審閱過：這次的規格不存（舊的不能蓋掉新的審閱）', async () => {
    const mem = memoryReview(review());
    const { codex } = fakeCodex((schema) => {
      if (schema === specSchema) {
        mem.set({ ...review(), reviewedAt: '2026-10-30T00:00:00.000Z' }); // 寫規格的時候你按了重新審閱
        return { markdown: '# 舊的規格' };
      }
      return { findings: [] };
    });
    await generateSpec({ codex, settings: () => settings, cwd: '/data', updateReview: mem.updateReview, log: () => {} }, 'ALL-1');
    expect(mem.get().spec).toBeUndefined();
  });

  it('審查角色都失敗：記下失敗，不給開發的 AI 半成品', async () => {
    const mem = memoryReview(review());
    const { codex } = fakeCodex((schema) => (schema === specSchema ? { markdown: '# 規格' } : undefined));
    await generateSpec({ codex, settings: () => settings, cwd: '/data', updateReview: mem.updateReview, log: () => {} }, 'ALL-1');
    expect(mem.get().spec).toMatchObject({ status: 'failed', error: '四個審查角色都沒有完成' });
    expect(specBrief(mem.get())).toBe('');
  });

  it('什麼時候開始寫規格：還沒寫、換版前審閱好的、寫到一半重新啟動過的要寫；正在寫的等它；寫好或失敗的不動', () => {
    const r = review();
    expect(specNextStep(r, null)).toBe('start'); // 換版前就審閱好的複雜單：還沒有規格
    expect(specNextStep(r, r.reviewedAt)).toBe('wait');
    const spec = { step: '', markdown: '', findings: [], failedReviewers: 0, reviewedAt: r.reviewedAt, at: '' };
    expect(specNextStep({ ...r, spec: { ...spec, status: 'running' } }, null)).toBe('start'); // 存著寫規格中，卻沒在寫
    expect(specNextStep({ ...r, spec: { ...spec, status: 'done' } }, null)).toBe('none');
    expect(specNextStep({ ...r, spec: { ...spec, status: 'failed' } }, null)).toBe('none');
    expect(specNextStep({ ...r, spec: { ...spec, status: 'failed' } }, null, true)).toBe('start'); // 你按重試
    expect(specNextStep({ ...r, spec: { ...spec, status: 'done', reviewedAt: '舊的審閱' } }, null)).toBe('start'); // 重新審閱過
    expect(specNextStep({ ...r, spec: { ...spec, status: 'done', reviewedAt: '舊的審閱' } }, '舊的審閱')).toBe('start'); // 舊的在寫，不等它
    expect(specNextStep(review({ level: '一般' }), null)).toBe('none');
  });

  it('重寫規格：上一版問的、你還沒回答的拿掉，回答過的留著；同樣的問題不重複', () => {
    const base = review({ issues: [
      { id: 'a', type: '需求不明確', importance: '重要', title: '舊的沒回答', detail: '', quote: '', from: 'ALL-1', suggestion: '', status: 'open', fromSpec: true },
      { id: 'b', type: '需求不明確', importance: '重要', title: '舊的回答了', detail: '', quote: '', from: 'ALL-1', suggestion: '', status: 'answered', answer: '要', fromSpec: true },
    ] });
    const next = withSpecQuestions(base, [{ title: '舊的回答了', detail: '', suggestion: '' }, { title: '新的問題', detail: '', suggestion: '建議' }]);
    expect(next.issues.map((i) => i.title)).toEqual(['舊的回答了', '新的問題']);
  });
});

describe('做完後比對規格', () => {
  const check: SpecCheck = {
    status: 'done', verdict: '', at: '',
    items: [
      { no: 1, kind: 'wrong', severity: 'high', text: '沒檢查 POA 狀態', evidence: '', status: 'open' },
      { no: 2, kind: 'wrong', severity: 'medium', text: '日期欄位沒鎖', evidence: '', status: 'open' },
      { no: 3, kind: 'unsure', severity: 'low', text: '規格假設的欄位不存在', evidence: '', status: 'open' },
    ],
  };

  it('讀開發的 AI 附的處理結果：修好的不用你看，不改的和不確定誰對的要你看過', () => {
    const replied = applySpecReplies(check, '改好了。\n```flowpilot-spec\n[{"no":1,"status":"fixed","note":"加上狀態 S 的判斷"},{"no":2,"status":"kept","note":"日期本來就鎖了"}]\n```');
    expect(replied.items.map((i) => [i.status, i.reply])).toEqual([['fixed', '加上狀態 S 的判斷'], ['kept', '日期本來就鎖了'], ['open', undefined]]);
    expect(specItemsForYou(replied).map((i) => i.no)).toEqual([2, 3]);
    expect(specItemsForYou({ ...replied, items: replied.items.map((i) => ({ ...i, seen: true })) })).toEqual([]);
  });

  it('沒附處理結果、或格式壞了：維持原狀', () => {
    expect(applySpecReplies(check, '我改好了')).toBe(check);
    expect(applySpecReplies(check, '```flowpilot-spec\n[壞掉\n```')).toBe(check);
  });
});
