#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { cpSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { detectPlatform, listPlatforms, getPlatformConfig } from '../src/util/platform.mjs';
import { download } from '../src/download.mjs';
import { unpack } from '../src/unpack.mjs';
import { patch } from '../src/patch.mjs';

function parseArgs(argv) {
  let platform = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform') platform = argv[++i];
  }
  return { platform };
}

async function buildPlatform(platformKey) {
  const distDir = resolve('dist', platformKey);
  const pkgDir = resolve('dist', `pkg-${platformKey}`);

  console.log(`\n${'='.repeat(55)}`);
  console.log(` Building: ${platformKey}`);
  console.log(`${'='.repeat(55)}\n`);

  // 1. Download
  console.log('[1/4] Downloading...');
  const binaryPath = await download(platformKey, distDir);

  // 2. Unpack
  console.log('\n[2/4] Unpacking...');
  const runtimeDir = join(distDir, 'runtime');
  await unpack(binaryPath, runtimeDir);

  // 3. Patch
  console.log('\n[3/4] Patching...');
  const result = await patch(runtimeDir);
  if (result.missing > 0) {
    console.warn(`[build] ${result.missing} optional patch(es) did not match this version (non-fatal)`);
  }

  // 4. Package
  console.log('\n[4/4] Packaging...');
  if (existsSync(pkgDir)) rmSync(pkgDir, { recursive: true, force: true });

  cpSync(resolve('pkg'), pkgDir, { recursive: true });
  cpSync(runtimeDir, join(pkgDir, 'runtime'), { recursive: true });

  // remove the cached binary + tarball to save space
  const cacheDir = join(distDir, '.cache');
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  const tarGlob = join(pkgDir, 'runtime', 'assets.tar-*.gz');
  for (const f of [tarGlob]) {
    try {
      const files = execFileSync('sh', ['-c', `ls ${f} 2>/dev/null`], { encoding: 'utf8' }).trim().split('\n');
      for (const file of files) if (file) rmSync(file);
    } catch {}
  }

  // stamp version into the output package.json
  const upstreamVersion = detectUpstreamVersion(join(pkgDir, 'runtime'));
  const outPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (upstreamVersion) outPkg.version = upstreamVersion;
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(outPkg, null, 2) + '\n');

  console.log(`\n  Output: ${pkgDir}`);
  console.log(`  Version: ${outPkg.version}`);
  console.log(`  Publish: cd ${pkgDir} && npm publish`);

  return pkgDir;
}

function detectUpstreamVersion(runtimeDir) {
  try {
    const js = readFileSync(join(runtimeDir, 'claude-science.js'), 'utf8');
    const m = js.match(/0\.1\.0-dev\.\d{8}\.t\d{6}\.sha[a-f0-9]+/);
    return m ? m[0].replace(/^0\.1\.0-dev\./, '0.1.0-') : null;
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let platforms;

  if (args.platform === 'all') {
    platforms = listPlatforms();
  } else if (args.platform) {
    platforms = [args.platform];
  } else {
    const detected = detectPlatform();
    if (!detected) {
      console.error(`Cannot detect platform. Use --platform (${listPlatforms().join('|')}|all)`);
      process.exit(1);
    }
    platforms = [detected];
  }

  for (const p of platforms) {
    getPlatformConfig(p);
    await buildPlatform(p);
  }

  console.log('\nBuild complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
