import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as acorn from 'acorn';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patch as applyPatches } from '../../src/patch.mjs';
import { PATCHES } from '../../src/patches.mjs';
import { walk } from '../../src/util/walk.mjs';

describe('custom model name filter patch', () => {
  it('P14 matches the upstream emoji/kebab-case hidden-name filter', () => {
    const source = String.raw`
      function hiddenModelName(name) {
        return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(name) ||
          /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name);
      }
    `;
    const ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    });
    let target = null;
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration') target = node;
    });

    const patch = PATCHES.find((item) => item.id === 'P14');
    assert.ok(patch);
    assert.equal(patch.match(target, source), true);
    assert.match(patch.replace(target, source).code, /cscience:P14/);
  });

  it('P14 is recognized after application and remains unchanged on a second pass', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cscience-p14-idempotent-'));
    const runtimePath = join(directory, 'claude-science.js');
    const source = String.raw`
      function hiddenModelName(name) {
        return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(name) ||
          /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name);
      }
    `;

    try {
      writeFileSync(runtimePath, source);
      const first = await applyPatches(directory);
      const afterFirst = readFileSync(runtimePath, 'utf8');
      const second = await applyPatches(directory);

      assert.equal(first.stats.P14, 'APPLIED');
      assert.equal(second.stats.P14, 'SKIPPED');
      assert.equal(readFileSync(runtimePath, 'utf8'), afterFirst);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails patching when required P14 is absent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cscience-p14-required-'));
    try {
      writeFileSync(join(directory, 'claude-science.js'), 'function unrelated(){return true}');
      await assert.rejects(
        applyPatches(directory),
        /Required patch\(es\) did not match: P14/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
