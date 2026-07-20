import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as acorn from 'acorn';
import { walk } from './util/walk.mjs';
import { PATCHES } from './patches.mjs';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function applyReplacements(code, replacements) {
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    code = code.slice(0, r.start) + r.code + code.slice(r.end);
  }
  return code;
}

export async function patch(dir, opts = {}) {
  const jsPath = `${dir}/claude-science.js`;
  const raw = await readFile(jsPath, 'utf8');
  const hashBefore = sha256(raw);

  console.log(`[patch] File: ${jsPath} (${(raw.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[patch] SHA-256 before: ${hashBefore.slice(0, 16)}...`);

  console.log('[patch] Parsing AST...');
  const t0 = performance.now();
  let ast;
  try {
    ast = acorn.parse(raw, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (e) {
    throw Error(`Acorn parse failed: ${e.message}`);
  }
  console.log(`[patch] Parsed in ${((performance.now() - t0) / 1000).toFixed(2)}s`);

  const replacements = [];
  const stats = {};
  for (const p of PATCHES) stats[p.id] = 'NOT_FOUND';

  for (const p of PATCHES) {
    if (stats[p.id] !== 'NOT_FOUND') continue;
    if ('_target' in p) p._target = null;
    if (p.preScan) p.preScan(ast);
  }

  const debug = opts.debug || process.env.BYOK_DEBUG === '1';
  console.log('[patch] Scanning AST for patch targets...');
  walk(ast, (node, parent) => {
    for (const p of PATCHES) {
      if (stats[p.id] === 'MATCHED' || stats[p.id] === 'SKIPPED') continue;
      try {
        if (p.matchApplied?.(node, parent, raw)) {
          stats[p.id] = 'SKIPPED';
          continue;
        }
        if (p.match(node, raw, parent, ast)) {
          const r = p.replace(node, raw, ast);
          if (r) {
            replacements.push({ ...r, id: p.id });
            stats[p.id] = 'MATCHED';
          }
        }
      } catch (e) {
        if (debug) console.warn(`[patch] ${p.id} match error: ${e.message}`);
      }
    }
  });

  const requiredMissing = PATCHES
    .filter(
      (patchDefinition) =>
        patchDefinition.required && stats[patchDefinition.id] === 'NOT_FOUND',
    )
    .map((patchDefinition) => patchDefinition.id);
  if (requiredMissing.length > 0) {
    throw Error(`[patch] Required patch(es) did not match: ${requiredMissing.join(', ')}`);
  }

  const toApply = replacements.filter(r => stats[r.id] === 'MATCHED');
  let code = raw;
  if (toApply.length > 0) {
    code = applyReplacements(code, toApply);
    for (const r of toApply) stats[r.id] = 'APPLIED';
  }

  console.log('[patch] Validating patched code...');
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (e) {
    const lastApplied = toApply[toApply.length - 1];
    throw Error(`Post-patch validation FAILED (last applied: ${lastApplied?.id}): ${e.message}`);
  }

  const hashAfter = sha256(code);
  const changed = hashBefore !== hashAfter;

  if (changed) await writeFile(jsPath, code);

  console.log('');
  console.log('  Patch Results');
  console.log('  ' + '-'.repeat(50));
  for (const p of PATCHES) {
    const s = stats[p.id];
    const icon = s === 'APPLIED'   ? '\x1b[32mAPPLIED\x1b[0m' :
                 s === 'SKIPPED'   ? '\x1b[33mSKIPPED\x1b[0m' :
                                     '\x1b[31mNOT_FOUND\x1b[0m';
    console.log(`  [${p.id.padEnd(3)}] ${p.name.padEnd(30)} ${icon}`);
  }
  console.log('  ' + '-'.repeat(50));
  console.log(`  SHA-256 after:  ${hashAfter.slice(0, 16)}...`);
  console.log(`  Status: ${changed ? 'PATCHED' : 'UNCHANGED'}`);
  console.log('');

  const applied = Object.values(stats).filter(s => s === 'APPLIED').length;
  const skipped = Object.values(stats).filter(s => s === 'SKIPPED').length;
  const missing = Object.values(stats).filter(s => s === 'NOT_FOUND').length;

  if (missing > 0) console.warn(`[patch] WARNING: ${missing} patch(es) did not match.`);

  return {
    applied,
    skipped,
    missing,
    requiredMissing,
    changed,
    hashBefore,
    hashAfter,
    stats,
  };
}
