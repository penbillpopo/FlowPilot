import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillFromCache, type I18nEntry, parseProgress, saveToCache, readWorkFile, TRANSLATE_LANGS, translateAll, translateUrls, writeI18nSheet } from '../src/main/i18n-sheet';

const sheet = (path: string) => execFileSync('unzip', ['-p', path, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });

describe('多語系', () => {
  it('讀工作檔：同一個 key 以後面的為準，壞掉的行、沒有英文的略過', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'i18n-test-')), 'w.jsonl');
    writeFileSync(path, ['{"key":"a","en-us":"A"}', '壞掉', '{"key":"b","en-us":""}', '{"key":"a","en-us":"A2"}', ''].join('\n'));
    expect(readWorkFile(path)).toEqual([{ key: 'a', texts: { 'en-us': 'A2' } }]);
    expect(readWorkFile(join(tmpdir(), '不存在.jsonl'))).toEqual([]);
  });

  it('讀進度：取最後一次寫的', () => {
    expect(parseProgress('多語系進度：未完成\n…\n多語系進度：完成')).toBe('done');
    expect(parseProgress('多語系進度：未完成（還剩 Casino）')).toBe('pending');
    expect(parseProgress('改好了')).toBeNull();
  });

  it('分批翻譯：每批 10 條；缺翻譯的那批再試一次，還缺的回報出來', async () => {
    const entries: I18nEntry[] = Array.from({ length: 45 }, (_, i) => ({ key: `k${i}`, texts: { 'en-us': `T${i}` } }));
    const calls: number[] = [];
    const full = (key: string) => ({ key, ...Object.fromEntries(TRANSLATE_LANGS.map((l) => [l, `${l}:${key}`])) });
    let k44Tries = 0;
    const missing = await translateAll(entries, async (prompt) => {
      const batch: { key: string }[] = JSON.parse(prompt.split('\n').at(-1)!);
      calls.push(batch.length);
      // k44 一直翻不好；k3 第一次漏掉、第二次補上
      return {
        entries: batch
          .filter((e) => !(e.key === 'k3' && calls.length <= 3))
          .map((e) => (e.key === 'k44' ? (k44Tries++, { ...full(e.key), ja: '' }) : full(e.key))),
      };
    });
    expect(missing).toEqual(['k44']);
    expect(k44Tries).toBe(2);
    expect(entries[3].texts.ja).toBe('ja:k3');
    expect(entries[0].texts['zh-cn']).toBe('zh-cn:k0');
    expect(calls.slice(0, 5)).toEqual([10, 10, 10, 10, 5]);
  });

  it('翻過的沿用：key 和英文都一樣才算，英文改了要重翻', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'i18n-test-')), '快取.json');
    const done = (key: string, en: string): I18nEntry => ({ key, texts: { 'en-us': en, ...Object.fromEntries(TRANSLATE_LANGS.map((l) => [l, `${l}:${en}`])) } });
    saveToCache([done('a', 'A'), done('b', 'B'), { key: 'c', texts: { 'en-us': 'C', ja: '只有日文' } }], file);
    const entries: I18nEntry[] = [{ key: 'a', texts: { 'en-us': 'A' } }, { key: 'b', texts: { 'en-us': 'B 改了' } }, { key: 'c', texts: { 'en-us': 'C' } }];
    expect(fillFromCache(entries, file).map((e) => e.key)).toEqual(['b', 'c']);
    expect(entries[0].texts.ja).toBe('ja:A');
  });

  it('翻譯檔網址換成這張單的商戶', () => {
    const env = "translateUrl: `${apiUrl}/configs/LanguageTranslate/Web8/[lang].json`,\nenvironment.translateUrl = `https://sit.example.com/configs3/LanguageTranslate/Web10/[lang].json,https://sit.example.com/configs/LanguageTranslate/Web10/[lang].json`;";
    expect(translateUrls(env, 7)).toEqual([
      'https://sit.example.com/configs3/LanguageTranslate/Web7/[lang].json',
      'https://sit.example.com/configs/LanguageTranslate/Web7/[lang].json',
    ]);
  });

  it('寫進檔案：同一天接著加，同一個 key＋商戶更新那一列，特殊字元不會壞', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'i18n-test-')), '多語系.xlsx');
    await writeI18nSheet([{ key: 'a_key', texts: { 'en-us': 'Settings > Security & "more"' } }], 10, path);
    await writeI18nSheet([{ key: 'b_key', texts: { 'en-us': 'B' } }, { key: 'a_key', texts: { 'en-us': 'A2', ja: 'エー' } }], 10, path);
    const xml = sheet(path);
    expect(xml.match(/<row /g)).toHaveLength(3);
    expect(xml).toContain('>a_key<');
    expect(xml).toContain('>A2<');
    expect(xml).toContain('>エー<');
    expect(xml).not.toContain('Security');
    expect(xml).toContain('>b_key<');
  });

  it('接在使用者原本的檔案後面，原本的列保留', async () => {
    const template = '/Users/ban/Desktop/多語系-1014.xlsx';
    if (!existsSync(template)) return;
    const path = join(mkdtempSync(join(tmpdir(), 'i18n-test-')), 'copy.xlsx');
    copyFileSync(template, path);
    await writeI18nSheet([{ key: 'new_key', texts: { 'en-us': 'New' } }], 10, path);
    const xml = sheet(path);
    expect(xml).toContain('your_phone_is_verified_for_country_notice');
    expect(xml).toContain('Settings &gt; Security');
    expect(xml).toContain('>new_key<');
  });
});
