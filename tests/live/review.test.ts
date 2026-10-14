// 實測（LIVE=1 才跑）：用真實 Jira 與 Codex 審閱兩張單，並討論一輪
import { tmpdir } from 'node:os';
import { it } from 'vitest';
import { CodexRpc } from '../../src/main/codex/rpc';
import { runStructured } from '../../src/main/codex/structured';
import { buildJql, getIssueContext, loadCredentials, searchTickets, statusIdsByName } from '../../src/main/jira';
import { applyDiscussion, buildCodeCheckPrompt, buildDiscussionPrompt, buildReviewPrompt, discussionSchema, REVIEW_INSTRUCTIONS, reviewSchema, sanitizeReview } from '../../src/main/planner/review';
import { loadSettings } from '../../src/main/settings';

it.runIf(process.env.LIVE)('真實審閱', { timeout: 900_000 }, async () => {
  const settings = loadSettings(`${process.env.HOME}/Library/Application Support/FlowPilot/設定.yaml`);
  const credentials = loadCredentials(settings.jira.envFile);
  const all = await searchTickets(credentials, buildJql(settings.jira.filter, ['待辦事項', '進行中', 'UAT', 'READY TO TEST'], await statusIdsByName(credentials)));
  const tickets = all.filter((t) => ['ALL-14324', 'ALL-14404'].includes(t.key));
  const rpc = new CodexRpc();
  await Promise.all(
    tickets.map(async (ticket) => {
      const t0 = Date.now();
      const sub = await getIssueContext(credentials, ticket.key);
      const main = ticket.parent ? await getIssueContext(credentials, ticket.parent.key) : null;
      const { result, threadId } = await runStructured<any>(rpc, {
        cwd: tmpdir(), keep: true, developerInstructions: REVIEW_INSTRUCTIONS, prompt: buildReviewPrompt(ticket, sub, main, settings, []), schema: reviewSchema(settings), timeoutMs: 300_000,
      });
      let review = sanitizeReview(result, ticket, settings);
      const codePrompt = review.level !== '小' && !review.codeChecked ? buildCodeCheckPrompt(review.entries, settings) : null;
      let commands = 0;
      const off = rpc.on((m) => { if (m.params?.threadId === threadId && m.method === 'item/started' && m.params.item?.type === 'commandExecution') commands++; });
      if (codePrompt) {
        const checked = await runStructured<any>(rpc, { cwd: tmpdir(), keep: true, threadId, developerInstructions: REVIEW_INSTRUCTIONS, prompt: codePrompt, schema: reviewSchema(settings), timeoutMs: 300_000 });
        review = sanitizeReview({ ...checked.result, codeChecked: true }, ticket, settings);
      }
      off();
      const seconds = ((Date.now() - t0) / 1000).toFixed(0);
      const lines = [`\n${ticket.key}「${ticket.summary}」（${seconds} 秒｜${review.level}單｜${review.codeChecked ? `有看程式碼，執行了 ${commands} 個指令` : '只看單'}）`, `  專案：${review.entries.map((e) => e.project).join('、')}`];
      for (const i of review.issues) lines.push(`  [${i.importance}｜${i.type}] ${i.title}\n      原文：${i.quote.slice(0, 80)}\n      建議：${i.suggestion}`);
      if (review.issues[0]) {
        const t1 = Date.now();
        const text = `關於「${review.issues[0].title}」：PM 說照你的建議做就好。`;
        const discussed = await runStructured<any>(rpc, { cwd: tmpdir(), keep: true, threadId, developerInstructions: REVIEW_INSTRUCTIONS, prompt: buildDiscussionPrompt(review, text), schema: discussionSchema, timeoutMs: 300_000 });
        review = applyDiscussion(review, text, discussed.result);
        lines.push(`  討論（${((Date.now() - t1) / 1000).toFixed(0)} 秒）：AI 回覆「${discussed.result.reply.slice(0, 120)}」`);
        lines.push(`  第一個問題現在是：${review.issues[0].status}（${review.issues[0].answer ?? ''}）`);
      }
      console.log(lines.join('\n'));
    }),
  );
  rpc.stop();
});
