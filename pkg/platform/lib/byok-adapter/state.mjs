import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { ADAPTER_VERSION } from './config.mjs';

export function defaultStatePath(homeDirectory = homedir()) {
  return join(homeDirectory, '.claude-science', 'byok-adapter.json');
}

export function readAdapterState(statePath = defaultStatePath()) {
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAdapterState(state, statePath = defaultStatePath()) {
  const directory = join(statePath, '..');
  mkdirSync(directory, { recursive: true });
  const payload = {
    pid: state.pid,
    host: state.host,
    port: state.port,
    localToken: state.localToken,
    baseUrlFingerprint: state.baseUrlFingerprint,
    credentialFingerprint: state.credentialFingerprint,
    configFingerprint: state.configFingerprint,
    persistent: state.persistent === true,
    leases: Array.isArray(state.leases)
      ? state.leases
          .filter(
            (lease) => lease && Number.isInteger(lease.pid) && typeof lease.token === 'string',
          )
          .map((lease) => ({
            pid: lease.pid,
            token: lease.token,
            createdAt: lease.createdAt || new Date().toISOString(),
          }))
      : [],
    startedAt: state.startedAt || new Date().toISOString(),
    version: state.version || ADAPTER_VERSION,
  };
  writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(statePath, 0o600);
  } catch {
    // best-effort on platforms that ignore chmod
  }
  return payload;
}

export function clearAdapterState(statePath = defaultStatePath()) {
  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
    } catch {
      // ignore
    }
  }
}

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isPortReachable(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Returns usable live state or null if stale (and clears file when stale).
 */
export async function loadLiveAdapterState(options = {}) {
  const statePath = options.statePath || defaultStatePath();
  const expectedFingerprint = options.baseUrlFingerprint || null;
  const expectedCredentialFingerprint = options.credentialFingerprint || null;
  const expectedConfigFingerprint = options.configFingerprint || null;
  const expectedVersion = options.version || null;
  const state = readAdapterState(statePath);
  if (!state) return null;

  const alive = isProcessAlive(state.pid);
  if (!alive) {
    clearAdapterState(statePath);
    return null;
  }

  const reachable = await isPortReachable(state.host, state.port);
  if (!reachable) {
    clearAdapterState(statePath);
    return null;
  }

  if (
    expectedFingerprint &&
    state.baseUrlFingerprint &&
    state.baseUrlFingerprint !== expectedFingerprint
  ) {
    return { state, mismatch: true };
  }

  if (
    expectedCredentialFingerprint &&
    state.credentialFingerprint !== expectedCredentialFingerprint
  ) {
    return { state, mismatch: true };
  }

  if (
    expectedConfigFingerprint &&
    state.configFingerprint !== expectedConfigFingerprint
  ) {
    return { state, mismatch: true };
  }

  if (expectedVersion && state.version !== expectedVersion) {
    return { state, mismatch: true };
  }

  return { state, mismatch: false };
}

export async function stopAdapterProcess(state, options = {}) {
  const statePath = options.statePath || defaultStatePath();
  if (!state?.pid) {
    clearAdapterState(statePath);
    return { stopped: false, stale: true, reason: 'missing-pid' };
  }
  if (!isProcessAlive(state.pid)) {
    clearAdapterState(statePath);
    return { stopped: false, stale: true, reason: 'process-not-running' };
  }

  const verified = await probeAdapterIdentity(state, {
    timeoutMs: options.probeTimeoutMs,
  });
  if (!verified) {
    clearAdapterState(statePath);
    return { stopped: false, stale: true, reason: 'identity-mismatch' };
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    // process may have exited after identity verification
  }
  const deadline = Date.now() + (options.waitMs ?? 5000);
  while (Date.now() < deadline && isProcessAlive(state.pid)) {
    await sleep(50);
  }
  if (isProcessAlive(state.pid)) {
    const stillVerified = await probeAdapterIdentity(state, {
      timeoutMs: options.probeTimeoutMs,
    });
    if (stillVerified) {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // process may have exited after the second identity verification
      }
      const killDeadline = Date.now() + 1000;
      while (Date.now() < killDeadline && isProcessAlive(state.pid)) {
        await sleep(25);
      }
    }
  }
  const stopped = !isProcessAlive(state.pid);
  if (stopped) clearAdapterState(statePath);
  return {
    stopped,
    stale: !stopped,
    reason: stopped ? null : 'process-did-not-stop',
  };
}

export function probeAdapterIdentity(state, options = {}) {
  return new Promise((resolve) => {
    if (!state?.host || !state?.port || !state?.localToken) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = httpRequest(
      {
        host: state.host,
        port: state.port,
        path: '/health',
        method: 'GET',
        headers: {
          'x-api-key': state.localToken,
          connection: 'close',
        },
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total <= 16 * 1024) chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200 || total > 16 * 1024) {
            finish(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(
              body?.ok === true &&
              (body.pid == null || Number(body.pid) === Number(state.pid)),
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    request.setTimeout(options.timeoutMs ?? 800, () => {
      request.destroy();
      finish(false);
    });
    request.once('error', () => finish(false));
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
