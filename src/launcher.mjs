import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(__dirname, '..', 'templates');

export function generateLauncher(outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const launcherSrc = readFileSync(join(TEMPLATES, 'launcher.sh'), 'utf8');
  const launcherDest = join(outputDir, 'launch.sh');
  writeFileSync(launcherDest, launcherSrc);
  chmodSync(launcherDest, 0o755);
  console.log(`[launcher] Created ${launcherDest}`);

  const configDir = join(homedir(), '.claude-science');
  const configPath = join(configDir, 'byok.env');

  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true });
    const template = readFileSync(join(TEMPLATES, 'byok.env'), 'utf8');
    writeFileSync(configPath, template, { mode: 0o600 });
    console.log(`[launcher] Config created: ${configPath}`);
    console.log(`[launcher] Edit it to set your ANTHROPIC_API_KEY`);
  } else {
    console.log(`[launcher] Config exists: ${configPath}`);
  }

  return { launcher: launcherDest, config: configPath };
}
