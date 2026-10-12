// 用 macOS 的 say 指令把指揮官語音預先錄成音檔（src/renderer/public/voice），打包進 FlowPilot。
// 為什麼：瀏覽器的語音合成每台電腦拿到的聲音不一定一樣，男聲壓低音調也容易失真；預先錄好每次都一樣。
// 改台詞或聲音後重新執行：node scripts/make-voices.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = join(import.meta.dirname, '../src/renderer/public/voice');

/** 台詞：檔名 → 內容（跟 src/renderer/src/skin.ts 的 VOICE_LINES 對應） */
const LINES = {
  selected: { allied: 'Allied forces selected.', soviet: 'Soviet empire selected.' },
  building: 'Building.',
  complete: 'Construction complete.',
  authorize: 'Authorization required.',
  orders: 'Awaiting orders, commander.',
  unable: 'Unable to comply.',
  canceled: 'Canceled.',
  accomplished: 'Mission accomplished.',
  options: 'New construction options.',
};

/** 盟軍：美國女聲；蘇聯：英國男聲、放慢。不要用 [[pbas]] 硬壓音調，聲音會變形（使用者聽過 7 個候選，選了原音的 Daniel） */
const VOICES = {
  allied: { voice: 'Samantha', rate: 175, prefix: '' },
  soviet: { voice: 'Daniel', rate: 150, prefix: '' },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [faction, { voice, rate, prefix }] of Object.entries(VOICES)) {
  for (const [name, line] of Object.entries(LINES)) {
    const text = typeof line === 'string' ? line : line[faction];
    const file = join(out, `${faction}-${name}.m4a`);
    execFileSync('say', ['-v', voice, '-r', String(rate), '-o', file, '--file-format=m4af', '--data-format=aac', prefix + text]);
    console.log(`${faction}-${name}.m4a：${text}`);
  }
}
