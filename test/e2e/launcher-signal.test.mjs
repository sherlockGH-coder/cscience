import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../../pkg/platform/lib/byok-adapter/state.mjs';
import {
  ensureAdapter,
  stopManagedAdapter,
} from '../../pkg/platform/lib/byok-adapter/manage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('platform launcher signal lifecycle', () => {
  it('SIGINT stops the runtime and removes the adapter process/state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-signal-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');

    try {
      mkdirSync(join(platform, 'runtime', 'assets'), { recursive: true });
      mkdirSync(join(home, '.claude-science'), { recursive: true });
      cpSync(join(REPO_ROOT, 'pkg', 'platform', 'bin'), join(platform, 'bin'), {
        recursive: true,
      });
      cpSync(join(REPO_ROOT, 'pkg', 'platform', 'lib'), join(platform, 'lib'), {
        recursive: true,
      });
      cpSync(
        join(REPO_ROOT, 'pkg', 'platform', 'templates'),
        join(platform, 'templates'),
        { recursive: true },
      );
      cpSync(
        join(REPO_ROOT, 'test', 'fixtures', 'fake-claude-science.js'),
        join(platform, 'runtime', 'claude-science.js'),
      );
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          'ANTHROPIC_API_KEY=sk-signal-fake-key',
          'ANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic',
          'BYOK_API_FORMAT=openai-chat',
          'BYOK_DEBUG=1',
          '',
        ].join('\n'),
      );

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        {
          env: { ...process.env, HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      launcher.stdout.setEncoding('utf8');
      launcher.stderr.setEncoding('utf8');
      launcher.stdout.on('data', (chunk) => { output += chunk; });
      launcher.stderr.on('data', (chunk) => { output += chunk; });

      await waitFor(() => output.includes('[fake-runtime] ready'), 10_000, output);
      assert.equal(existsSync(statePath), true);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(isProcessAlive(state.pid), true);
      assert.match(output, /adapter listening/);

      launcher.kill('SIGINT');
      const exit = await waitForExit(launcher, 10_000);
      assert.equal(exit.code, 130);
      await waitFor(
        () => !existsSync(statePath) && !isProcessAlive(state.pid),
        7_000,
        output,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the adapter after a slow successful runtime daemonization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-daemonize-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');
    const runtimeDaemonState = join(root, 'runtime-daemon.state');

    try {
      mkdirSync(join(platform, 'runtime', 'assets'), { recursive: true });
      mkdirSync(join(home, '.claude-science'), { recursive: true });
      cpSync(join(REPO_ROOT, 'pkg', 'platform', 'bin'), join(platform, 'bin'), {
        recursive: true,
      });
      cpSync(join(REPO_ROOT, 'pkg', 'platform', 'lib'), join(platform, 'lib'), {
        recursive: true,
      });
      cpSync(
        join(REPO_ROOT, 'pkg', 'platform', 'templates'),
        join(platform, 'templates'),
        { recursive: true },
      );
      cpSync(
        join(REPO_ROOT, 'test', 'fixtures', 'fake-claude-science.js'),
        join(platform, 'runtime', 'claude-science.js'),
      );
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          'ANTHROPIC_API_KEY=sk-daemonize-fake-key',
          'ANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic',
          'BYOK_API_FORMAT=openai-chat',
          '',
        ].join('\n'),
      );

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        {
          env: {
            ...process.env,
            HOME: home,
            FAKE_RUNTIME_EXIT_AFTER_MS: '3200',
            FAKE_RUNTIME_EXIT_CODE: '0',
            FAKE_RUNTIME_DAEMONIZE: '1',
            FAKE_RUNTIME_DAEMON_STATE: runtimeDaemonState,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      launcher.stdout.setEncoding('utf8');
      launcher.stderr.setEncoding('utf8');
      launcher.stdout.on('data', (chunk) => { output += chunk; });
      launcher.stderr.on('data', (chunk) => { output += chunk; });

      await waitFor(() => output.includes('[fake-runtime] ready'), 10_000, output);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const exit = await waitForExit(launcher, 10_000);
      assert.equal(exit.code, 0);
      assert.equal(existsSync(statePath), true);
      assert.equal(isProcessAlive(state.pid), true);
    } finally {
      if (existsSync(statePath)) {
        await stopManagedAdapter({ statePath });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops the adapter after a successful foreground runtime exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-foreground-exit-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');

    try {
      preparePlatform(platform, home);
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          'ANTHROPIC_API_KEY=sk-foreground-fake-key',
          'ANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic',
          'BYOK_API_FORMAT=openai-chat',
          '',
        ].join('\n'),
      );

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        {
          env: {
            ...process.env,
            HOME: home,
            FAKE_RUNTIME_EXIT_AFTER_MS: '100',
            FAKE_RUNTIME_EXIT_CODE: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const exit = await waitForExit(launcher, 10_000);
      assert.equal(exit.code, 0);
      await waitFor(() => !existsSync(statePath), 7_000, 'adapter state remained');
    } finally {
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows stop without provider credentials and cleans the adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-stop-no-creds-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');

    try {
      preparePlatform(platform, home);
      const adapter = await ensureAdapter({
        ANTHROPIC_API_KEY: 'sk-stop-fake-key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic',
        BYOK_API_FORMAT: 'openai-chat',
      }, { statePath, homeDirectory: home });
      writeFileSync(join(home, '.claude-science', 'byok.env'), '# credentials removed\n');

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'stop'],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exit = await waitForExit(launcher, 10_000);
      assert.equal(exit.code, 0);
      await waitFor(
        () => !existsSync(statePath) && !isProcessAlive(adapter.pid),
        7_000,
        'adapter was not stopped',
      );
    } finally {
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not retain the provider credential in the adapter process environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-env-secret-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');
    const secret = 'sk-process-environment-fake-key';

    try {
      preparePlatform(platform, home);
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        `ANTHROPIC_API_KEY=${secret}\nANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic\n`,
      );
      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await waitFor(() => existsSync(statePath), 10_000, 'adapter state missing');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const processDetails = execFileSync('ps', ['eww', '-p', String(state.pid)], {
        encoding: 'utf8',
      });
      assert.equal(processDetails.includes(secret), false);
      launcher.kill('SIGINT');
      await waitForExit(launcher, 10_000);
    } finally {
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not pass provider credentials to runtime management commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-management-env-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const capturedEnv = join(root, 'runtime-env.json');
    const apiKey = 'sk-management-api-key-not-real';
    const authToken = 'management-auth-token-not-real';

    try {
      preparePlatform(platform, home);
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          `ANTHROPIC_API_KEY=${apiKey}`,
          `ANTHROPIC_AUTH_TOKEN=${authToken}`,
          'ANTHROPIC_BASE_URL=https://provider.invalid/anthropic',
          '',
        ].join('\n'),
      );

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'status'],
        {
          env: {
            ...process.env,
            HOME: home,
            FAKE_RUNTIME_ENV_OUTPUT: capturedEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitForExit(launcher, 10_000);

      const runtimeEnv = JSON.parse(readFileSync(capturedEnv, 'utf8'));
      assert.notEqual(runtimeEnv.ANTHROPIC_API_KEY, apiKey);
      assert.notEqual(runtimeEnv.ANTHROPIC_AUTH_TOKEN, authToken);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts the runtime from a sandbox-safe internal working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-runtime-cwd-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const capturedEnv = join(root, 'runtime-env.json');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');

    try {
      preparePlatform(platform, home);
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          'ANTHROPIC_API_KEY=sk-runtime-cwd-fake-key',
          'ANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic',
          'BYOK_API_FORMAT=openai-chat',
          '',
        ].join('\n'),
      );

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HOME: home,
            FAKE_RUNTIME_ENV_OUTPUT: capturedEnv,
            FAKE_RUNTIME_EXIT_AFTER_MS: '100',
            FAKE_RUNTIME_EXIT_CODE: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const exit = await waitForExit(launcher, 10_000);
      assert.equal(exit.code, 0);
      const runtimeEnv = JSON.parse(readFileSync(capturedEnv, 'utf8'));
      const expectedCwd = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
      assert.equal(runtimeEnv.cwd, expectedCwd);
      assert.equal(runtimeEnv.pwd, expectedCwd);
      await waitFor(() => !existsSync(statePath), 7_000, 'adapter state remained');
    } finally {
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a shared adapter alive until the last foreground launcher exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-shared-adapter-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');
    let first = null;
    let second = null;

    try {
      preparePlatform(platform, home);
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          'ANTHROPIC_API_KEY=sk-shared-fake-key',
          'ANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic',
          'BYOK_API_FORMAT=openai-chat',
          '',
        ].join('\n'),
      );

      first = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let firstOutput = '';
      first.stdout.setEncoding('utf8');
      first.stderr.setEncoding('utf8');
      first.stdout.on('data', (chunk) => { firstOutput += chunk; });
      first.stderr.on('data', (chunk) => { firstOutput += chunk; });
      await waitFor(() => firstOutput.includes('[fake-runtime] ready'), 10_000, firstOutput);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));

      second = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let secondOutput = '';
      second.stdout.setEncoding('utf8');
      second.stderr.setEncoding('utf8');
      second.stdout.on('data', (chunk) => { secondOutput += chunk; });
      second.stderr.on('data', (chunk) => { secondOutput += chunk; });
      await waitFor(
        () => secondOutput.includes('[fake-runtime] ready') && secondOutput.includes('adapter reused'),
        10_000,
        secondOutput,
      );

      first.kill('SIGINT');
      await waitForExit(first, 10_000);
      first = null;
      assert.equal(isProcessAlive(state.pid), true);
      assert.equal(existsSync(statePath), true);

      second.kill('SIGINT');
      await waitForExit(second, 10_000);
      second = null;
      await waitFor(
        () => !existsSync(statePath) && !isProcessAlive(state.pid),
        7_000,
        secondOutput,
      );
    } finally {
      if (first && first.exitCode === null) first.kill('SIGKILL');
      if (second && second.exitCode === null) second.kill('SIGKILL');
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not stop a daemon-owned adapter when a later foreground launcher exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-daemon-lease-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');
    const runtimeDaemonState = join(root, 'runtime-daemon.state');
    let foreground = null;

    try {
      preparePlatform(platform, home);
      writeFileSync(
        join(home, '.claude-science', 'byok.env'),
        [
          'ANTHROPIC_API_KEY=sk-daemon-shared-fake-key',
          'ANTHROPIC_BASE_URL=http://127.0.0.1:9/anthropic',
          'BYOK_API_FORMAT=openai-chat',
          '',
        ].join('\n'),
      );

      const daemonizing = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        {
          env: {
            ...process.env,
            HOME: home,
            FAKE_RUNTIME_EXIT_AFTER_MS: '100',
            FAKE_RUNTIME_EXIT_CODE: '0',
            FAKE_RUNTIME_DAEMONIZE: '1',
            FAKE_RUNTIME_DAEMON_STATE: runtimeDaemonState,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const daemonExit = await waitForExit(daemonizing, 10_000);
      assert.equal(daemonExit.code, 0);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(isProcessAlive(state.pid), true);

      foreground = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'serve'],
        {
          env: { ...process.env, HOME: home, FAKE_RUNTIME_DAEMON_STATE: runtimeDaemonState },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      foreground.stdout.setEncoding('utf8');
      foreground.stderr.setEncoding('utf8');
      foreground.stdout.on('data', (chunk) => { output += chunk; });
      foreground.stderr.on('data', (chunk) => { output += chunk; });
      await waitFor(
        () => output.includes('[fake-runtime] ready') && output.includes('adapter reused'),
        10_000,
        output,
      );

      foreground.kill('SIGINT');
      await waitForExit(foreground, 10_000);
      foreground = null;
      assert.equal(isProcessAlive(state.pid), true);
      assert.equal(existsSync(statePath), true);
    } finally {
      if (foreground && foreground.exitCode === null) foreground.kill('SIGKILL');
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops a managed adapter when byok.env is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cscience-launcher-stop-missing-config-'));
    const platform = join(root, 'platform');
    const home = join(root, 'home');
    const statePath = join(home, '.claude-science', 'byok-adapter.json');

    try {
      preparePlatform(platform, home);
      const adapter = await ensureAdapter({
        ANTHROPIC_API_KEY: 'sk-missing-config-fake-key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic',
        BYOK_API_FORMAT: 'openai-chat',
      }, { statePath, homeDirectory: home });

      const launcher = spawn(
        'bun',
        [join(platform, 'bin', 'claude-science.mjs'), 'stop'],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exit = await waitForExit(launcher, 10_000);
      assert.equal(exit.code, 0);
      await waitFor(
        () => !existsSync(statePath) && !isProcessAlive(adapter.pid),
        7_000,
        'adapter remained after stop with missing byok.env',
      );
    } finally {
      if (existsSync(statePath)) await stopManagedAdapter({ statePath });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function preparePlatform(platform, home) {
  mkdirSync(join(platform, 'runtime', 'assets'), { recursive: true });
  mkdirSync(join(home, '.claude-science'), { recursive: true });
  cpSync(join(REPO_ROOT, 'pkg', 'platform', 'bin'), join(platform, 'bin'), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, 'pkg', 'platform', 'lib'), join(platform, 'lib'), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, 'pkg', 'platform', 'templates'), join(platform, 'templates'), {
    recursive: true,
  });
  cpSync(
    join(REPO_ROOT, 'test', 'fixtures', 'fake-claude-science.js'),
    join(platform, 'runtime', 'claude-science.js'),
  );
}

async function waitFor(predicate, timeoutMs, diagnostic) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for condition. Output:\n${diagnostic}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      rejectExit(new Error('launcher did not exit after SIGINT'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}
