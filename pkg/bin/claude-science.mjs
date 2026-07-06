#!/usr/bin/env bun
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { spawn, execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME = resolve(__dirname, '..', 'runtime');
const ENTRY = join(RUNTIME, 'claude-science.js');
const ASSETS = join(RUNTIME, 'assets');
const CONFIG_DIR = join(homedir(), '.claude-science');
const CONFIG_FILE = join(CONFIG_DIR, 'byok.env');
const TEMPLATE = resolve(__dirname, '..', 'templates', 'byok.env');

function checkBun() {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('Error: bun is required but not found. Install from https://bun.sh');
    process.exit(1);
  }
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (existsSync(TEMPLATE)) {
      copyFileSync(TEMPLATE, CONFIG_FILE);
    } else {
      writeFileSync(CONFIG_FILE, [
        '# Claude Science BYOK Config',
        '# ANTHROPIC_API_KEY=sk-ant-...',
        '# ANTHROPIC_BASE_URL=',
        '# OPERON_MODELS=',
        '# PORT=8000',
        '',
      ].join('\n'), { mode: 0o600 });
    }
    console.log(`Config created: ${CONFIG_FILE}`);
    console.log(`Edit it to set your ANTHROPIC_API_KEY, then re-run.\n`);
    process.exit(0);
  }

  const env = {};
  for (const line of readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val) env[key] = val;
  }
  return env;
}

function main() {
  checkBun();
  const config = loadConfig();
  const args = process.argv.slice(2);

  if (!config.ANTHROPIC_API_KEY && !config.ANTHROPIC_AUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(`No credentials. Edit ${CONFIG_FILE} and set ANTHROPIC_API_KEY.`);
    process.exit(1);
  }

  const command = args[0];
  const isServe = !command || command === 'serve' || command.startsWith('-');
  if (isServe) {
    const serveArgs = ['serve', '--assets-root', ASSETS];
    if (config.PORT && !args.includes('--port')) serveArgs.push('--port', config.PORT);
    if (config.NO_AUTO_UPDATE) serveArgs.push('--no-auto-update');
    const extra = args.slice(command === 'serve' ? 1 : 0);
    serveArgs.push(...extra);

    const child = spawn('bun', [ENTRY, ...serveArgs], {
      stdio: 'inherit',
      env: { ...process.env, ...config },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const child = spawn('bun', [ENTRY, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...config },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
