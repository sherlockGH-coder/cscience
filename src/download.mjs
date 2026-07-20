import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getPlatformConfig } from './util/platform.mjs';
import { extractFromDmg } from './util/dmg.mjs';

function verifySha256(filePath, expected) {
  if (!expected) return;
  const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  if (actual !== expected) {
    throw Error(
      `[download] SHA-256 mismatch!\n  expected: ${expected}\n  actual:   ${actual}\n` +
      `The downloaded binary may be corrupted or tampered with. Aborting.`
    );
  }
  console.log(`[download] SHA-256 verified: ${actual.slice(0, 16)}...`);
}

export async function download(platformKey, outputDir) {
  const cfg = getPlatformConfig(platformKey);
  const cacheDir = join(outputDir, '.cache');
  mkdirSync(cacheDir, { recursive: true });

  const binaryDest = join(cacheDir, 'claude-science');
  if (existsSync(binaryDest)) {
    console.log(`[download] Cached binary found: ${binaryDest}`);
    verifySha256(binaryDest, cfg.sha256);
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

  verifySha256(binaryDest, cfg.sha256);
  return binaryDest;
}
