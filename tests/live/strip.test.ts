// 實測（LIVE=1 才跑）：真實的單讀進來時，原始需求整段已經拿掉
import { it } from 'vitest';
import { getIssueContext, loadCredentials } from '../../src/main/jira';
import { loadSettings } from '../../src/main/settings';

it.runIf(process.env.LIVE)('真實的單拿掉原始需求', async () => {
  const settings = loadSettings(`${process.env.HOME}/Library/Application Support/FlowPilot/設定.yaml`);
  const context = await getIssueContext(loadCredentials(settings.jira.envFile), 'ALL-12747');
  console.log('內文開頭：\n' + context.description.slice(0, 400));
  console.log('有沒有原始需求：', /Merchant Requirements|原始需求/.test(context.description));
  console.log('參考資料：', context.resources.map((r) => `[${r.kind}] ${r.title}`).join('、'));
});
