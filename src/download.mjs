import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformConfig } from './util/platform.mjs';
import { extractFromDmg } from './util/dmg.mjs';

export async function download(platformKey, outputDir) {
  const cfg = getPlatformConfig(platformKey);
  const cacheDir = join(outputDir, '.cache');
  mkdirSync(cacheDir, { recursive: true });

  const binaryDest = join(cacheDir, 'claude-science');
  if (existsSync(binaryDest)) {
    console.log(`[download] Cached binary found: ${binaryDest}`);
    return binaryDest;
  }

  console.log(`[download] Fetching ${platformKey} from ${cfg.url}`);

  if (cfg.format === 'dmg') {
    const dmgPath = join(cacheDir, `${platformKey}.dmg`);
    if (!existsSync(dmgPath)) {
      console.log(`[download] Downloading DMG...`);
      execFileSync('curl', ['-fSL', '--progress-bar', '--retry', '3', '-o', dmgPath, cfg.url], {
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: 1200_000,
      });
    }
    console.log(`[download] Extracting binary from DMG...`);
    const extracted = extractFromDmg(dmgPath, cfg.binaryPath);
    copyFileSync(extracted, binaryDest);
    chmodSync(binaryDest, 0o755);
    console.log(`[download] Binary extracted: ${binaryDest}`);
  } else {
    console.log(`[download] Downloading binary...`);
    execFileSync('curl', ['-fSL', '--progress-bar', '--retry', '3', '-o', binaryDest, cfg.url], {
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: 1200_000,
    });
    chmodSync(binaryDest, 0o755);
    console.log(`[download] Binary saved: ${binaryDest}`);
  }

  return binaryDest;
}
