import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMockProvider } from '../helpers/mock-provider.mjs';
import {
  ensureAdapter,
  releaseAdapterLease,
  stopManagedAdapter,
  getAdapterStatus,
} from '../../pkg/platform/lib/byok-adapter/manage.mjs';
import { isProcessAlive } from '../../pkg/platform/lib/byok-adapter/state.mjs';

describe('adapter daemon mock E2E', () => {
  let mock;
  let mockInfo;
  let homeDir;
  let statePath;

  before(async () => {
    mock = createMockProvider();
    mock.setHandler('GET /v1/models', {
      status: 200,
      body: { data: [{ id: 'e2e-model', name: 'E2E' }] },
    });
    mock.setHandler('POST /v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl_e2e',
        model: 'e2e-model',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'e2e ok' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    });
    mockInfo = await mock.start();
    homeDir = mkdtempSync(join(tmpdir(), 'cscience-byok-e2e-'));
    mkdirSync(join(homeDir, '.claude-science'), { recursive: true });
    statePath = join(homeDir, '.claude-science', 'byok-adapter.json');
  });

  after(async () => {
    try {
      await stopManagedAdapter({ statePath });
    } catch {
      // ignore
    }
    await mock.stop();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('starts adapter, serves models/messages, stops cleanly', async () => {
    const adapter = await ensureAdapter(
      {
        ANTHROPIC_API_KEY: 'sk-e2e-fake-key-not-real',
        ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
        BYOK_API_FORMAT: 'openai-chat',
      },
      { statePath, homeDirectory: homeDir },
    );

    assert.ok(adapter.port);
    assert.ok(adapter.localToken.length >= 32);

    const status = getAdapterStatus({ statePath });
    assert.equal(status.running, true);

    const models = await fetch(`http://127.0.0.1:${adapter.port}/v1/models`, {
      headers: { 'x-api-key': adapter.localToken },
    });
    assert.equal(models.status, 200);
    const modelsJson = await models.json();
    assert.equal(modelsJson.data[0].id, 'e2e-model');

    const message = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': adapter.localToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'e2e-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    assert.equal(message.status, 200);
    const messageJson = await message.json();
    assert.equal(messageJson.content[0].text, 'e2e ok');

    // Secret leakage checks on status file.
    const stateRaw = await import('node:fs').then((fs) =>
      fs.readFileSync(statePath, 'utf8'),
    );
    assert.ok(!stateRaw.includes('sk-e2e-fake-key-not-real'));
    assert.ok(stateRaw.includes(adapter.localToken));
    assert.match(stateRaw, /"credentialFingerprint"/);

    const stop = await stopManagedAdapter({ statePath });
    assert.equal(stop.stopped, true);
    const after = getAdapterStatus({ statePath });
    assert.equal(after.running, false);
  });

  it('restarts adapter when the credential changes for the same Base URL', async () => {
    const first = await ensureAdapter(
      {
        ANTHROPIC_API_KEY: 'sk-first-fake-key',
        ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
        BYOK_API_FORMAT: 'openai-chat',
      },
      { statePath, homeDirectory: homeDir },
    );

    const second = await ensureAdapter(
      {
        ANTHROPIC_API_KEY: 'sk-second-fake-key',
        ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
        BYOK_API_FORMAT: 'openai-chat',
      },
      { statePath, homeDirectory: homeDir },
    );

    assert.notEqual(second.pid, first.pid);
    assert.equal(second.reused, false);
    await stopManagedAdapter({ statePath });
  });

  it('restarts adapter when behavior configuration changes', async () => {
    const first = await ensureAdapter(
      {
        ANTHROPIC_API_KEY: 'sk-same-fake-key',
        ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
        BYOK_API_FORMAT: 'openai-chat',
      },
      { statePath, homeDirectory: homeDir },
    );

    const second = await ensureAdapter(
      {
        ANTHROPIC_API_KEY: 'sk-same-fake-key',
        ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
        BYOK_API_FORMAT: 'openai-responses',
      },
      { statePath, homeDirectory: homeDir },
    );

    assert.notEqual(second.pid, first.pid);
    assert.equal(second.reused, false);
    await stopManagedAdapter({ statePath });
  });

  it('does not replace a daemon-owned adapter with incompatible configuration', async () => {
    const first = await ensureAdapter(
      {
        ANTHROPIC_API_KEY: 'sk-persistent-fake-key',
        ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
        BYOK_API_FORMAT: 'openai-chat',
      },
      { statePath, homeDirectory: homeDir },
    );
    await releaseAdapterLease(first, {
      statePath,
      homeDirectory: homeDir,
      stopIfUnused: false,
    });

    await assert.rejects(
      ensureAdapter(
        {
          ANTHROPIC_API_KEY: 'sk-new-persistent-fake-key',
          ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
          BYOK_API_FORMAT: 'openai-responses',
        },
        { statePath, homeDirectory: homeDir },
      ),
      /Existing BYOK adapter is in use/,
    );
    assert.equal(isProcessAlive(first.pid), true);
    await stopManagedAdapter({ statePath });
  });

  it('serializes concurrent starts and reuses one managed adapter', async () => {
    const config = {
      ANTHROPIC_API_KEY: 'sk-concurrent-fake-key',
      ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
      BYOK_API_FORMAT: 'openai-chat',
    };

    const [first, second] = await Promise.all([
      ensureAdapter(config, { statePath, homeDirectory: homeDir }),
      ensureAdapter(config, { statePath, homeDirectory: homeDir }),
    ]);

    assert.equal(first.pid, second.pid);
    assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
    assert.equal(isProcessAlive(first.pid), true);
    assert.equal(existsSync(`${statePath}.lock`), false);

    const stopped = await stopManagedAdapter({ statePath });
    assert.equal(stopped.stopped, true);
    assert.equal(isProcessAlive(first.pid), false);
  });

  it('does not signal a PID when adapter identity verification fails', async () => {
    writeFileSync(statePath, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 1,
      localToken: `stale-${'x'.repeat(40)}`,
      version: '1.0.0',
    }));

    const result = await stopManagedAdapter({
      statePath,
      probeTimeoutMs: 50,
      waitMs: 50,
    });
    assert.equal(result.stopped, false);
    assert.equal(result.reason, 'identity-mismatch');
    assert.equal(existsSync(statePath), false);
  });

  it('stops a newly started adapter when its state file cannot be written', async () => {
    const brokenStatePath = join(homeDir, '.claude-science', 'state-is-a-directory');
    const marker = `BYOK_STATE_WRITE_FAILURE_${process.pid}_${Date.now()}`;
    mkdirSync(brokenStatePath);
    let adapterPid = null;

    try {
      await assert.rejects(
        ensureAdapter(
          {
            ANTHROPIC_API_KEY: 'sk-state-write-fake-key',
            ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
            BYOK_API_FORMAT: 'openai-chat',
          },
          {
            statePath: brokenStatePath,
            homeDirectory: homeDir,
            env: { BYOK_TEST_INSTANCE_ID: marker },
          },
        ),
      );
      adapterPid = findProcessPidByMarker(marker);
      assert.equal(adapterPid, null);
    } finally {
      adapterPid ??= findProcessPidByMarker(marker);
      if (adapterPid && isProcessAlive(adapterPid)) {
        process.kill(adapterPid, 'SIGKILL');
      }
      rmSync(brokenStatePath, { recursive: true, force: true });
    }
  });
});

function findProcessPidByMarker(marker) {
  const output = execFileSync('ps', ['eww', '-ax', '-o', 'pid=,command='], {
    encoding: 'utf8',
  });
  for (const line of output.split('\n')) {
    if (!line.includes(marker) || !line.includes('byok-adapter/daemon.mjs')) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}
