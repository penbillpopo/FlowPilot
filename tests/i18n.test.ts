// 英文版有沒有翻完整：掃過程式碼裡所有中文字串，
// - 畫面（renderer）：每一句中文都要包在 t()（要翻）或 zhOnly()（故意不翻，例如給 AI 的指示）裡。
// - 後端（main）：給人看的地方（錯誤訊息、狀態 activity、通知…）要包在 t() 或 zhOnly() 裡；給 AI 的指示、紀錄不用。
// - 前面有「i18n-keys」註解的對照表：裡面的中文之後會拿去 t()，一樣要有英文。
// - t() 用到的每一句，英文對照表都要有，英文裡不能有中文，{變數} 要一樣。
// 只檢查某些檔案：I18N_FILES=ChatPanel,SidePanels npx vitest run tests/i18n.test.ts
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from '../src/shared/locales/en';

const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule) as typeof traverseModule;
const CJK = /[㐀-鿿！-～　-〿]/;
const ROOT = join(__dirname, '..');
/** 後端給人看的欄位：狀態、說明、問題、按鈕文字… */
const USER_KEYS = new Set(['activity', 'note', 'question', 'label', 'header', 'reason', 'message', 'title', 'body', 'detail', 'hint', 'error']);
const USER_CALLS = new Set(['notify', 'show', 'showMessageBox', 'showErrorBox']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) && name !== 'i18n.ts' ? [path] : [];
  });
}

interface Finding {
  where: string;
  text: string;
}

function scan(path: string, keys: Map<string, string>, untranslated: Finding[]) {
  const source = readFileSync(path, 'utf8');
  const rel = relative(ROOT, path);
  const backend = rel.startsWith('src/main/');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  const visit = (node: any, text: string, ancestors: any[]) => {
    if (!CJK.test(text)) return;
    const where = `${rel}:${node.loc?.start.line}`;
    // 包在 t() / zhOnly() 的第一個參數
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === 'CallExpression' && a.callee.type === 'Identifier' && (a.callee.name === 't' || a.callee.name === 'zhOnly') && a.arguments[0] && within(a.arguments[0], node)) {
        if (a.callee.name === 't') {
          if (a.arguments[0].type !== 'StringLiteral') untranslated.push({ where, text: `t() 的第一個參數要是固定字串：${text}` });
          else keys.set(a.arguments[0].value, where);
        }
        return;
      }
    }
    // 型別、import、物件的 key 不算
    if (ancestors.some((a) => a.type === 'ImportDeclaration' || /^TS/.test(a.type))) return;
    const parent = ancestors[ancestors.length - 1];
    if ((parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod') && parent.key === node) return;
    // 標了 i18n-keys 的對照表：之後會拿去 t()，要有英文
    if (ancestors.some((a) => (a.leadingComments ?? []).some((c: any) => c.value.includes('i18n-keys')))) {
      keys.set(text, where);
      return;
    }
    if (!backend) {
      untranslated.push({ where, text });
      return;
    }
    // 後端：只管給人看的地方
    const userFacing = ancestors.some(
      (a) =>
        (a.type === 'NewExpression' && a.callee.type === 'Identifier' && /Error$/.test(a.callee.name)) ||
        (a.type === 'ObjectProperty' && a.key.type === 'Identifier' && USER_KEYS.has(a.key.name) && within(a.value, node)) ||
        (a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.property.type === 'Identifier' && USER_CALLS.has(a.callee.property.name)) ||
        (a.type === 'CallExpression' && a.callee.type === 'Identifier' && USER_CALLS.has(a.callee.name)),
    );
    if (userFacing) untranslated.push({ where, text });
  };
  traverse(ast as any, {
    StringLiteral(p) {
      visit(p.node, p.node.value, p.getAncestry().slice(1).reverse().map((x) => x.node));
    },
    TemplateLiteral(p) {
      const text = p.node.quasis.map((q) => q.value.cooked ?? '').join('${}');
      visit(p.node, text, p.getAncestry().slice(1).reverse().map((x) => x.node));
    },
    JSXText(p) {
      visit(p.node, p.node.value.trim(), p.getAncestry().slice(1).reverse().map((x) => x.node));
    },
  });
}

function within(outer: any, inner: any): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

const only = (process.env.I18N_FILES ?? '').split(',').filter(Boolean);
const targets = [...files(join(ROOT, 'src/renderer/src')), ...files(join(ROOT, 'src/main')), ...files(join(ROOT, 'src/shared')), ...files(join(ROOT, 'src/preload'))].filter(
  (f) => !only.length || only.some((o) => f.includes(o)),
);

describe('英文版翻譯完整', () => {
  const keys = new Map<string, string>();
  const untranslated: Finding[] = [];
  for (const f of targets) scan(f, keys, untranslated);

  it('給人看的中文都包在 t() 或 zhOnly() 裡', () => {
    expect(untranslated.map((u) => `${u.where}  ${u.text.slice(0, 60)}`)).toEqual([]);
  });

  it('t() 用到的每一句都有英文，英文裡沒有中文，{變數} 一樣', () => {
    const problems: string[] = [];
    for (const [zh, where] of keys) {
      const en = EN[zh];
      if (en === undefined) problems.push(`${where}  缺英文：${zh}`);
      else if (CJK.test(en)) problems.push(`${where}  英文裡有中文：${zh} → ${en}`);
      else {
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
        if (vars(zh) !== vars(en)) problems.push(`${where}  變數不一樣：${zh} → ${en}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
