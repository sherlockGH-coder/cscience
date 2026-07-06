import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function extractFromDmg(dmgPath, innerPath) {
  const mountPoint = mkdtempSync(join(tmpdir(), 'cs-dmg-'));
  try {
    execFileSync('hdiutil', [
      'attach', dmgPath,
      '-nobrowse', '-noverify', '-noautoopen',
      '-mountpoint', mountPoint,
    ], { stdio: 'pipe', timeout: 60_000 });

    const src = join(mountPoint, innerPath);
    const dest = join(tmpdir(), `claude-science-${Date.now()}`);
    cpSync(src, dest);
    return dest;
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], {
        stdio: 'pipe', timeout: 30_000,
      });
    } catch {}
    try { rmSync(mountPoint, { recursive: true, force: true }); } catch {}
  }
}
