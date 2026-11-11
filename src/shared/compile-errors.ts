// 從本機網站終端機的輸出找出「最近一次編譯」的錯誤（Angular：npm start / ng serve）。
// 只看最後一次編譯：改好以後重新編譯成功，錯誤就不再顯示。

/** 拿掉終端機的顏色、游標控制碼 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n');
}

/** 一次編譯開始的地方：重新執行指令（> ng serve…）或改檔案後重新編譯。之後的輸出才是這次的結果 */
const BUILD_START = /^> .*$|Changes detected\. Rebuilding/gm;
/** 一個錯誤的開頭（esbuild 版是「✘ [ERROR]」，舊版 webpack 是「Error: src/...」或「ERROR in」） */
const ERROR_START = /^\s*(?:[✘x×]\s*)?\[ERROR\]|^\s*ERROR in |^\s*Error: src\/|^\s*src\/\S+\(\d+,\d+\): error TS/m;

export interface CompileErrors {
  /** 幾個錯誤 */
  count: number;
  /** 錯誤內容（給 AI 看；太長會截掉） */
  text: string;
  /** 每個錯誤的第一行（給你看） */
  titles: string[];
}

/** 最近一次編譯有錯就回傳錯誤；成功或還沒編譯完回傳 null */
export function compileErrors(output: string, maxText = 6000): CompileErrors | null {
  const clean = stripAnsi(output);
  let last = 0;
  for (const m of clean.matchAll(BUILD_START)) last = m.index!;
  const segment = clean.slice(last);
  const lines = segment.split('\n');
  const blocks: string[][] = [];
  for (const line of lines) {
    // 之後又編譯成功了：前面的錯誤都已經不算
    if (/Application bundle generation complete|Compiled successfully/.test(line)) {
      blocks.length = 0;
      continue;
    }
    if (ERROR_START.test(line)) blocks.push([line.trimEnd()]);
    else if (blocks.length && !/^\s*Watch mode enabled|^\s*Application bundle generation|^\s*Initial chunk files|^\s*➜/.test(line)) blocks[blocks.length - 1].push(line.trimEnd());
  }
  if (!blocks.length) return null;
  // 重新編譯時同一個錯誤會再印一次：一樣的只留一個
  const tidy = [...new Set(blocks.map((b) => b.join('\n').replace(/\n{3,}/g, '\n\n').trim()))];
  let text = tidy.join('\n\n');
  if (text.length > maxText) text = `${text.slice(0, maxText)}\n…`;
  return {
    count: tidy.length,
    text,
    titles: tidy.map((b) => b.split('\n')[0].replace(/^\s*(?:[✘x×]\s*)?\[ERROR\]\s*/, '').replace(/\s*\[plugin [^\]]+\]\s*$/, '').trim()),
  };
}
