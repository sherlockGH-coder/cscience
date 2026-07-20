/**
 * Launcher-side adapter process management (start / reuse / stop).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adapterConfigFingerprint,
  buildAdapterConfig,
  normalizeBaseUrl,
  parseCredential,
  ADAPTER_VERSION,
} from './config.mjs';
import { sha256Hex, credentialFingerprint } from './cache.mjs';
import {
  clearAdapterState,
  defaultStatePath,
  loadLiveAdapterState,
  readAdapterState,
  stopAdapterProcess,
  writeAdapterState,
  isProcessAlive,
  probeAdapterIdentity,
} from './state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = join(__dirname, 'daemon.mjs');
const READY_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;
const MALFORMED_LOCK_STALE_MS = READY_TIMEOUT_MS * 2;
const LOCK_OWNER_STALE_MS = LOCK_TIMEOUT_MS * 2;
const ADAPTER_CONFIG_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_VERSION',
  'OPERON_MODELS',
  'BYOK_API_FORMAT',
  'BYOK_MODELS_URL',
  'BYOK_PROVIDER',
  'BYOK_REASONING_EFFORT',
  'BYOK_DEBUG',
  'BYOK_LOCAL_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
];

export function isAdapterDisabled(env = process.env) {
  const value = env.BYOK_ADAPTER;
  return value === '0' || value === 'false' || value === 'off';
}

export function generateLocalToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Ensure a live adapter matching the current Base URL fingerprint.
 * Returns { host, port, localToken, pid, reused }.
 */
export async function ensureAdapter(userConfig, options = {}) {
  if (
    isAdapterDisabled(options.env || process.env) ||
    isAdapterDisabled(userConfig)
  ) {
    return null;
  }

  const statePath = options.statePath || defaultStatePath(options.homeDirectory);
  return withAdapterStateLock(
    statePath,
    () => ensureAdapterLocked(userConfig, options, statePath),
    options,
  );
}

async function ensureAdapterLocked(userConfig, options, statePath) {
  const baseUrlRaw =
    userConfig.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  const base = normalizeBaseUrl(baseUrlRaw);
  const baseUrlFingerprint = sha256Hex(base.href);
  const currentCredentialFingerprint = credentialFingerprint(
    parseCredential(userConfig),
  );
  const currentConfigFingerprint = adapterConfigFingerprint(userConfig);
  const lease = createAdapterLease(options);

  const live = await loadLiveAdapterState({
    statePath,
    baseUrlFingerprint,
    credentialFingerprint: currentCredentialFingerprint,
    configFingerprint: currentConfigFingerprint,
    version: ADAPTER_VERSION,
  });

  if (live?.state && !live.mismatch && live.state.localToken) {
    // Also require credential-compatible reuse: token must still authenticate.
    const healthy = await probeAdapterIdentity(live.state);
    if (healthy) {
      const stateWithLease = {
        ...live.state,
        leases: [...liveAdapterLeases(live.state), lease],
      };
      writeAdapterState(stateWithLease, statePath);
      return {
        host: live.state.host,
        port: live.state.port,
        localToken: live.state.localToken,
        pid: live.state.pid,
        reused: true,
        baseUrlFingerprint,
        credentialFingerprint: currentCredentialFingerprint,
        configFingerprint: currentConfigFingerprint,
        leaseToken: lease.token,
      };
    }
  }

  if (live?.state) {
    const foreignLeases = liveAdapterLeases(live.state).filter(
      (activeLease) => activeLease.pid !== lease.pid,
    );
    if (live.mismatch && (live.state.persistent === true || foreignLeases.length > 0)) {
      throw new Error(
        'Existing BYOK adapter is in use with different credentials or behavior. Run cscience stop before changing adapter configuration.',
      );
    }
    const result = await stopAdapterProcess(live.state, { statePath });
    if (result.reason === 'process-did-not-stop') {
      throw new Error(`Existing BYOK adapter process ${live.state.pid} did not stop`);
    }
  } else {
    // Clean any unreadable/stale file.
    const stale = readAdapterState(statePath);
    if (stale) {
      const result = await stopAdapterProcess(stale, { statePath });
      if (result.reason === 'process-did-not-stop') {
        throw new Error(`Existing BYOK adapter process ${stale.pid} did not stop`);
      }
    }
  }

  const localToken = generateLocalToken();
  const adapterConfigInput = {
    ANTHROPIC_API_KEY: userConfig.ANTHROPIC_API_KEY || '',
    ANTHROPIC_AUTH_TOKEN: userConfig.ANTHROPIC_AUTH_TOKEN || '',
    ANTHROPIC_BASE_URL: baseUrlRaw,
    OPERON_MODELS: userConfig.OPERON_MODELS || '',
    BYOK_API_FORMAT: userConfig.BYOK_API_FORMAT || 'auto',
    BYOK_MODELS_URL: userConfig.BYOK_MODELS_URL || '',
    BYOK_PROVIDER: userConfig.BYOK_PROVIDER || 'auto',
    BYOK_REASONING_EFFORT: userConfig.BYOK_REASONING_EFFORT || 'high',
    BYOK_DEBUG: userConfig.BYOK_DEBUG || '0',
    ANTHROPIC_VERSION: userConfig.ANTHROPIC_VERSION || '',
    BYOK_LOCAL_TOKEN: localToken,
    HTTPS_PROXY: userConfig.HTTPS_PROXY || '',
    HTTP_PROXY: userConfig.HTTP_PROXY || '',
  };

  // Validate config early so launcher fails before spawning.
  buildAdapterConfig(adapterConfigInput);

  const ready = await spawnAdapterDaemon(
    buildAdapterProcessEnv({ ...process.env, ...(options.env || {}) }),
    adapterConfigInput,
    options,
  );
  const newState = {
    pid: ready.pid,
    host: ready.host,
    port: ready.port,
    localToken,
    baseUrlFingerprint,
    credentialFingerprint: currentCredentialFingerprint,
    configFingerprint: currentConfigFingerprint,
    persistent: false,
    leases: [lease],
    startedAt: new Date().toISOString(),
    version: ADAPTER_VERSION,
  };
  try {
    writeAdapterState(newState, statePath);
  } catch (error) {
    await stopNewAdapterAfterStateFailure(newState, statePath);
    throw error;
  }

  return {
    host: ready.host,
    port: ready.port,
    localToken,
    pid: ready.pid,
    reused: false,
    baseUrlFingerprint,
    credentialFingerprint: currentCredentialFingerprint,
    configFingerprint: currentConfigFingerprint,
    leaseToken: lease.token,
  };
}

function createAdapterLease(options = {}) {
  return {
    pid: options.clientPid ?? process.pid,
    token: randomBytes(24).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
}

function liveAdapterLeases(state) {
  if (!Array.isArray(state?.leases)) return [];
  return state.leases.filter(
    (lease) =>
      lease &&
      Number.isInteger(lease.pid) &&
      typeof lease.token === 'string' &&
      isProcessAlive(lease.pid),
  );
}

async function withAdapterStateLock(statePath, callback, options = {}) {
  const release = await acquireAdapterStateLock(statePath, options);
  try {
    return await callback();
  } finally {
    release();
  }
}

async function acquireAdapterStateLock(statePath, options = {}) {
  const lockPath = `${statePath}.lock`;
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + (options.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
  mkdirSync(dirname(lockPath), { recursive: true });

  while (true) {
    let descriptor = null;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`,
      );
      closeSync(descriptor);
      descriptor = null;
      return () => releaseAdapterStateLock(lockPath, token);
    } catch (error) {
      const createdLock = descriptor !== null;
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // ignore close failure; stale-lock recovery handles the file
        }
      }
      if (createdLock && error?.code !== 'EEXIST') {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore; bounded stale-lock recovery handles a partial lock file
        }
      }
      if (error?.code !== 'EEXIST') throw error;

      if (lockCanBeRemoved(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for BYOK adapter state lock: ${lockPath}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_RETRY_MS));
    }
  }
}

function lockCanBeRemoved(lockPath) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch (error) {
    return error?.code === 'ENOENT';
  }

  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    const ownerExpired =
      Number.isFinite(owner?.createdAt) &&
      Date.now() - owner.createdAt >= LOCK_OWNER_STALE_MS;
    return !Number.isInteger(owner?.pid) || !isProcessAlive(owner.pid) || ownerExpired;
  } catch {
    return Date.now() - stat.mtimeMs >= MALFORMED_LOCK_STALE_MS;
  }
}

function releaseAdapterStateLock(lockPath, token) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (owner?.token !== token || Number(owner?.pid) !== process.pid) return;
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Leave an unreadable lock for bounded stale-lock recovery.
    }
  }
}

export function buildAdapterProcessEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of ADAPTER_CONFIG_ENV_KEYS) delete env[key];
  return env;
}

function spawnAdapterDaemon(env, configInput, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      detached: true,
    });

    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error('BYOK adapter ready handshake timed out after 10s'));
    }, options.readyTimeoutMs || READY_TIMEOUT_MS);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        finish(new Error(`Invalid adapter ready message: ${line}`));
        return;
      }
      if (message.type === 'error') {
        finish(new Error(message.message || 'Adapter failed to start'));
        return;
      }
      if (message.type !== 'ready' || !message.port) {
        finish(new Error(`Unexpected adapter message: ${line}`));
        return;
      }
      // Detach so adapter outlives launcher if daemonize happens.
      try {
        child.unref();
      } catch {
        // ignore
      }
      finish(null, {
        host: message.host || '127.0.0.1',
        port: message.port,
        pid: message.pid || child.pid,
      });
    });

    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(`BYOK adapter exited before ready (code ${code})`));
      }
    });
    child.stdin.once('error', (error) => finish(error));
    child.stdin.end(`${JSON.stringify(configInput)}\n`);
  });
}

async function stopNewAdapterAfterStateFailure(state, statePath) {
  const result = await stopAdapterProcess(state, { statePath });
  if (result.stopped || !isProcessAlive(state.pid)) return;

  // This PID belongs to the child spawned immediately above, so it is safe to
  // force cleanup even if the health probe failed before state persistence.
  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    return;
  }
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && isProcessAlive(state.pid)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

export async function stopManagedAdapter(options = {}) {
  const statePath = options.statePath || defaultStatePath(options.homeDirectory);
  return withAdapterStateLock(statePath, async () => {
    const state = readAdapterState(statePath);
    if (!state) return { stopped: false };
    const result = await stopAdapterProcess(state, {
      statePath,
      waitMs: options.waitMs,
      probeTimeoutMs: options.probeTimeoutMs,
    });
    return { ...result, pid: state.pid };
  }, options);
}

export async function releaseAdapterLease(adapterInfo, options = {}) {
  if (!adapterInfo?.leaseToken) {
    return { released: false, stopped: false, reason: 'missing-lease-token' };
  }
  const statePath = options.statePath || defaultStatePath(options.homeDirectory);
  return withAdapterStateLock(statePath, async () => {
    const state = readAdapterState(statePath);
    if (!state) {
      return { released: false, stopped: false, reason: 'missing-state' };
    }
    if (Number(state.pid) !== Number(adapterInfo.pid)) {
      return { released: false, stopped: false, reason: 'adapter-replaced' };
    }

    const activeLeases = liveAdapterLeases(state);
    const remainingLeases = activeLeases.filter(
      (lease) => lease.token !== adapterInfo.leaseToken,
    );
    const released = remainingLeases.length !== activeLeases.length;

    const persistent = state.persistent === true || options.stopIfUnused === false;
    if (remainingLeases.length > 0 || persistent) {
      writeAdapterState({ ...state, leases: remainingLeases, persistent }, statePath);
      return {
        released,
        stopped: false,
        remainingLeases: remainingLeases.length,
        persistent,
      };
    }

    const result = await stopAdapterProcess(state, {
      statePath,
      waitMs: options.waitMs,
      probeTimeoutMs: options.probeTimeoutMs,
    });
    return {
      ...result,
      released,
      remainingLeases: 0,
      pid: state.pid,
    };
  }, options);
}

export function getAdapterStatus(options = {}) {
  const statePath = options.statePath || defaultStatePath(options.homeDirectory);
  const state = readAdapterState(statePath);
  if (!state) {
    return { running: false };
  }
  const alive = isProcessAlive(state.pid);
  return {
    running: alive,
    pid: state.pid,
    host: state.host,
    port: state.port,
    startedAt: state.startedAt,
    version: state.version,
    stale: !alive,
  };
}

export function buildRuntimeEnv(userConfig, adapterInfo) {
  const env = { ...process.env, ...userConfig };

  if (!adapterInfo) {
    // Direct mode (BYOK_ADAPTER=0): pass through real credentials.
    return env;
  }

  env.ANTHROPIC_BASE_URL = `http://${adapterInfo.host}:${adapterInfo.port}`;
  env.ANTHROPIC_API_KEY = adapterInfo.localToken;
  delete env.ANTHROPIC_AUTH_TOKEN;

  // Keep OPERON_MODELS for P8 short-circuit in runtime.
  // Do not expose real provider key to Claude Science.
  return env;
}

export function buildManagementRuntimeEnv(userConfig, options = {}) {
  const env = { ...process.env, ...userConfig };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.BYOK_LOCAL_TOKEN;

  const statePath = options.statePath || defaultStatePath(options.homeDirectory);
  const state = readAdapterState(statePath);
  if (state?.host && state?.port && state?.localToken) {
    env.ANTHROPIC_BASE_URL = `http://${state.host}:${state.port}`;
    env.ANTHROPIC_API_KEY = state.localToken;
  }

  return env;
}

// Re-export for tests.
export { credentialFingerprint, clearAdapterState };
