// 暫時的實測：用真實 Jira 與 Codex 判斷幾張單（只在 LIVE=1 時執行）
import { tmpdir } from 'node:os';
import { it } from 'vitest';
import { CodexRpc } from '../../src/main/codex/rpc';
import { askStructured, listSkills } from '../../src/main/codex/structured';
import { buildJql, getIssueContext, loadCredentials, searchTickets, statusIdsByName } from '../../src/main/jira';
import { buildJudgePrompt, JUDGE_INSTRUCTIONS, judgementSchema, sanitizeJudgement } from '../../src/main/planner/judge';
import { DEFAULT_SETTINGS_YAML, parseSettings } from '../../src/main/settings';

it.runIf(process.env.LIVE)('真實判斷', { timeout: 600_000 }, async () => {
  const settings = parseSettings(DEFAULT_SETTINGS_YAML);
  const credentials = loadCredentials(settings.jira.envFile);
  const tickets = (await searchTickets(credentials, buildJql(settings.jira.filter, ['待辦事項', '進行中', 'UAT', 'READY TO TEST'], await statusIdsByName(credentials)))).filter((t) => ['ALL-14324', 'ALL-14404'].includes(t.key));
  const rpc = new CodexRpc();
  const skills = await listSkills(rpc, settings.folders[0].path);
  console.log('技能：', skills.map((s) => s.name).join('、'));
  await Promise.all(tickets.map(async (ticket) => {
    const t0 = Date.now();
    const sub = await getIssueContext(credentials, ticket.key);
    const main = ticket.parent ? await getIssueContext(credentials, ticket.parent.key) : null;
    const raw = await askStructured<any>(rpc, { cwd: tmpdir(), developerInstructions: JUDGE_INSTRUCTIONS, prompt: buildJudgePrompt(ticket, sub, main, settings, []), schema: judgementSchema(settings) });
    const j = sanitizeJudgement(raw, ticket.key, settings);
    j.resources = [...(main?.resources ?? []), ...sub.resources];
    console.log(`\n${ticket.key}「${ticket.summary}」（${((Date.now() - t0) / 1000).toFixed(1)} 秒）\n  ${j.entries.map((e) => `${e.project} ${e.merchants.join(',')}${e.sourceMerchant ? `（來源 ${e.sourceMerchant}）` : ''}：${e.reason}`).join('\n  ')}\n  標題：${j.prTitle}\n  說明：${j.reason}\n  要做什麼：\n    - ${j.summary.join('\n    - ')}\n  參考資料：\n    ${j.resources.map((r) => `[${r.kind}] ${r.title}`).join('\n    ')}`);
  }));
  rpc.stop();
});
