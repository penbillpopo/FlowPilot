import { describe, expect, it } from 'vitest';
import { diffSnapshots, lineDiff, updateMessage } from '../src/main/requirements';
import type { TicketSnapshot } from '../src/shared/types';

const snap = (key: string, patch: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  key, summary: '彈窗 Banner 增加存款條件', description: '需求\n- 未存款\n- 存款次數（等於）', comments: [{ id: '1', author: 'PM', updated: 't1', text: '請參考存款獎勵活動' }], attachments: ['a.png'], takenAt: '', ...patch,
});

describe('需求變更', () => {
  it('逐行差異只列新增與刪除', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'add', text: 'd' },
    ]);
  });

  it('找出標題、內文、新留言、修改的留言、新附件；分得出主單和子任務', () => {
    const before = [snap('ALL-1'), snap('ALL-0')];
    const after = [
      snap('ALL-1', { summary: '彈窗 Banner 增加存款條件（新版）', comments: [{ id: '1', author: 'PM', updated: 't2', text: '請參考存款獎勵活動，含當天' }, { id: '2', author: '王小明', updated: 't3', text: 'X 天以台北時間計算' }] }),
      snap('ALL-0', { description: '需求\n- 未存款\n- 存款次數（大於等於）', attachments: ['a.png', 'b.png'] }),
    ];
    const changes = diffSnapshots(before, after, 'ALL-1');
    expect(changes.map((c) => [c.kind, c.from, c.title])).toEqual([
      ['summary', 'ALL-1', '子任務標題被修改'],
      ['editedComment', 'ALL-1', 'PM修改了子任務的留言'],
      ['newComment', 'ALL-1', '王小明在子任務新增了一則留言'],
      ['description', 'ALL-0', '主單內文被修改'],
      ['newAttachment', 'ALL-0', '主單新增了 1 個附件'],
    ]);
    expect(changes[3].lines).toEqual([{ type: 'del', text: '- 存款次數（等於）' }, { type: 'add', text: '- 存款次數（大於等於）' }]);
  });

  it('只有時間變了（例如改狀態、指派人）不算變更；沒有舊快照也不算', () => {
    expect(diffSnapshots([snap('ALL-1')], [snap('ALL-1', { takenAt: 'later' })], 'ALL-1')).toEqual([]);
    expect(diffSnapshots(undefined, [snap('ALL-1')], 'ALL-1')).toEqual([]);
  });

  it('更新需求的訊息：沒有變更時只請 AI 回「這個需求沒有變更」', () => {
    const message = updateMessage([], [snap('ALL-1')]);
    expect(message).toContain('沒有任何變更');
    expect(message).toContain('請只回覆「這個需求沒有變更」');
  });

  it('更新需求的訊息：有變更時附上差異，請 AI 說明變更與打算怎麼改，先不改檔案', () => {
    const message = updateMessage([{ kind: 'description', from: 'ALL-0', title: '主單內文被修改', lines: [{ type: 'add', text: '- 新條件' }] }], [snap('ALL-1')]);
    expect(message).toContain('### 主單內文被修改（ALL-0）');
    expect(message).toContain('+ - 新條件');
    expect(message).toContain('(a) 說明變更的內容是什麼');
    expect(message).toContain('先不要修改任何檔案');
  });

  it('更新需求的訊息：沒有之前的快照時附上目前的完整內容，請 AI 自己比對', () => {
    const message = updateMessage(null, [snap('ALL-1')]);
    expect(message).toContain('沒有之前的快照');
    expect(message).toContain('- 存款次數（等於）');
    expect(message).toContain('PM：請參考存款獎勵活動');
  });
});
