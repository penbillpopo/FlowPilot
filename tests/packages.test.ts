import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCommand, missingPackages } from '../src/main/packages';

describe('套件有沒有裝齊', () => {
  it('package.json 列了、node_modules 沒有的就算缺（鎖定檔沒變也看得出來）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpilot-pkg-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'markdown-it': '15.0.2', rxjs: '7' }, devDependencies: { '@types/node': '20' } }));
    for (const name of ['rxjs', '@types/node']) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(join(dir, 'node_modules', name, 'package.json'), '{}');
    }
    expect(missingPackages(dir)).toEqual(['markdown-it']);
  });

  it('沒有 package.json 就不算缺；只缺套件時不改鎖定檔', () => {
    expect(missingPackages(mkdtempSync(join(tmpdir(), 'flowpilot-pkg-')))).toEqual([]);
    expect(installCommand(false)).toBe('npm install --no-save');
    expect(installCommand(true)).toBe('npm install');
  });
});
