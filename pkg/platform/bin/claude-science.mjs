#!/usr/bin/env bun
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {
  buildManagementRuntimeEnv,
  buildRuntimeEnv,
  ensureAdapter,
  getAdapterStatus,
  isAdapterDisabled,
  releaseAdapterLease,
  stopManagedAdapter,
} from '../lib/byok-adapter/manage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME = resolve(__dirname, '..', 'runtime');
const ENTRY = join(RUNTIME, 'claude-science.js');
const ASSETS = join(RUNTIME, 'assets');
const CONFIG_DIR = join(homedir(), '.claude-science');
const CONFIG_FILE = join(CONFIG_DIR, 'byok.env');
const TEMPLATE = resolve(__dirname, '..', 'templates', 'byok.env');
const RUNTIME_WORK_DIR =
  process.platform === 'darwin' && existsSync('/private/tmp')
    ? '/private/tmp'
    : tmpdir();

function checkBun() {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('Error: bun is required but not found. Install from https://bun.sh');
    process.exit(1);
  }
}

function loadConfig(options = {}) {
  if (!existsSync(CONFIG_FILE)) {
    if (options.createIfMissing === false) return {};
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

function spawnRuntime(args, env) {
  return spawn('bun', [ENTRY, ...args], {
    stdio: 'inherit',
    cwd: RUNTIME_WORK_DIR,
    env: buildRuntimeProcessEnv(env),
  });
}

function buildRuntimeProcessEnv(env) {
  if (process.platform === 'win32') return env;
  return { ...env, PWD: RUNTIME_WORK_DIR };
}

async function main() {
  checkBun();
  const args = process.argv.slice(2);
  const command = args[0];
  const isManagementCommand = command === 'status' || command === 'stop';
  const config = loadConfig({ createIfMissing: !isManagementCommand });
  const userConfig = {
    ...config,
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN } : {}),
    ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
    ...(process.env.ANTHROPIC_VERSION ? { ANTHROPIC_VERSION: process.env.ANTHROPIC_VERSION } : {}),
    ...(process.env.OPERON_MODELS ? { OPERON_MODELS: process.env.OPERON_MODELS } : {}),
    ...(process.env.BYOK_API_FORMAT ? { BYOK_API_FORMAT: process.env.BYOK_API_FORMAT } : {}),
    ...(process.env.BYOK_MODELS_URL ? { BYOK_MODELS_URL: process.env.BYOK_MODELS_URL } : {}),
    ...(process.env.BYOK_PROVIDER ? { BYOK_PROVIDER: process.env.BYOK_PROVIDER } : {}),
    ...(process.env.BYOK_REASONING_EFFORT ? { BYOK_REASONING_EFFORT: process.env.BYOK_REASONING_EFFORT } : {}),
    ...(process.env.BYOK_DEBUG ? { BYOK_DEBUG: process.env.BYOK_DEBUG } : {}),
    ...(process.env.BYOK_ADAPTER ? { BYOK_ADAPTER: process.env.BYOK_ADAPTER } : {}),
  };

  const isServe = !command || command === 'serve' || command.startsWith('-');

  if (command === 'status') {
    const child = spawnRuntime(args, buildManagementRuntimeEnv(userConfig));
    child.on('exit', (code) => {
      const adapterStatus = getAdapterStatus();
      if (adapterStatus.running) {
        console.log(
          `[BYOK] adapter running pid=${adapterStatus.pid} ${adapterStatus.host}:${adapterStatus.port}`,
        );
      } else if (adapterStatus.stale) {
        console.log('[BYOK] adapter state present but process not running');
      } else {
        console.log('[BYOK] adapter not running');
      }
      process.exit(code ?? 0);
    });
    return;
  }

  if (command === 'stop') {
    const child = spawnRuntime(args, buildManagementRuntimeEnv(userConfig));
    child.on('exit', async (code) => {
      try {
        const result = await stopManagedAdapter();
        if (result.stopped) {
          console.log(`[BYOK] adapter stopped (pid ${result.pid})`);
        } else if (result.reason) {
          console.warn(`[BYOK] adapter not stopped: ${result.reason}`);
        }
      } catch (error) {
        console.error(`[BYOK] failed to stop adapter: ${error.message}`);
      }
      process.exit(code ?? 0);
    });
    return;
  }

  if (!config.ANTHROPIC_API_KEY && !config.ANTHROPIC_AUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(`No credentials. Edit ${CONFIG_FILE} and set ANTHROPIC_API_KEY.`);
    process.exit(1);
  }

  if (!isServe) {
    // Other management commands: pass through without starting adapter.
    const child = spawnRuntime(args, buildManagementRuntimeEnv(userConfig));
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const serveArgs = ['serve', '--assets-root', ASSETS];
  if (userConfig.PORT && !args.includes('--port')) serveArgs.push('--port', userConfig.PORT);
  if (userConfig.NO_AUTO_UPDATE) serveArgs.push('--no-auto-update');
  const extra = args.slice(command === 'serve' ? 1 : 0);
  serveArgs.push(...extra);

  let adapterInfo = null;
  if (!isAdapterDisabled(process.env) && !isAdapterDisabled(userConfig)) {
    try {
      adapterInfo = await ensureAdapter(userConfig);
      if (adapterInfo) {
        const mode = adapterInfo.reused ? 'reused' : 'started';
        console.log(
          `[BYOK] adapter ${mode} on http://${adapterInfo.host}:${adapterInfo.port}`,
        );
      }
    } catch (error) {
      console.error(`[BYOK] adapter failed to start: ${error.message}`);
      console.error(
        '[BYOK] Refusing to start Claude Science with synthetic credentials. Fix the adapter or set BYOK_ADAPTER=0 for maintainer direct Anthropic mode.',
      );
      process.exit(1);
    }
  } else {
    console.warn(
      '[BYOK] adapter disabled (BYOK_ADAPTER=0). Using direct provider credentials. OpenAI/DeepSeek protocol conversion is unavailable.',
    );
  }

  const runtimeEnv = buildRuntimeEnv(userConfig, adapterInfo);
  const child = spawnRuntime(serveArgs, runtimeEnv);
  let shuttingDown = false;

  const releaseAdapter = async (stopIfUnused = true) => {
    if (!adapterInfo) return;
    try {
      await releaseAdapterLease(adapterInfo, { stopIfUnused });
    } catch (error) {
      console.error(`[BYOK] failed to release adapter lease: ${error.message}`);
    }
  };

  const waitForChildExit = (timeoutMs) => new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    const timeout = setTimeout(resolveExit, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });

  const runtimeDaemonIsRunning = () => new Promise((resolveStatus) => {
    const statusChild = spawn('bun', [ENTRY, 'status'], {
      stdio: 'ignore',
      cwd: RUNTIME_WORK_DIR,
      env: buildRuntimeProcessEnv(runtimeEnv),
    });
    let settled = false;
    const finish = (running) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveStatus(running);
    };
    const timeout = setTimeout(() => {
      try {
        statusChild.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish(false);
    }, 5000);
    statusChild.once('error', () => finish(false));
    statusChild.once('exit', (code) => finish(code === 0));
  });

  const shutdownFromSignal = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // child may have exited between the checks
      }
    }
    await waitForChildExit(5000);
    await releaseAdapter(true);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  process.once('SIGINT', () => {
    void shutdownFromSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdownFromSignal('SIGTERM');
  });

  child.on('exit', async (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const exitCode = code ?? (signal ? 1 : 0);
    const daemonRunning = exitCode === 0 && await runtimeDaemonIsRunning();
    await releaseAdapter(!daemonRunning);
    process.exit(exitCode);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
