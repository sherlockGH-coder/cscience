#!/usr/bin/env node
import { buildAdapterConfig } from './config.mjs';
import { createAdapterServer } from './server.mjs';
import { createLogger } from './log.mjs';

async function main() {
  let config;
  try {
    config = buildAdapterConfig(await readConfigFromStdin());
  } catch (error) {
    writeReadyError(error);
    process.exit(1);
  }

  const stderrOutput = {
    log: (line) => console.error(line),
    warn: (line) => console.error(line),
    error: (line) => console.error(line),
  };
  const logger = createLogger({ debug: config.byok.debug, output: stderrOutput });
  const adapter = createAdapterServer(config, { logger });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`adapter shutting down (${signal})`);
    await adapter.shutdown(5000);
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    const address = await adapter.listen(0, '127.0.0.1');
    const ready = {
      type: 'ready',
      host: address.host === '::' ? '127.0.0.1' : address.host,
      port: address.port,
      pid: process.pid,
    };
    process.stdout.write(`${JSON.stringify(ready)}\n`);
    logger.info(`adapter listening on ${ready.host}:${ready.port}`);
  } catch (error) {
    writeReadyError(error);
    process.exit(1);
  }
}

function readConfigFromStdin(options = {}) {
  const maxBytes = options.maxBytes || 1024 * 1024;
  const timeoutMs = options.timeoutMs || 10_000;
  return new Promise((resolveConfig, rejectConfig) => {
    let buffer = '';
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      if (error) rejectConfig(error);
      else resolveConfig(value);
    };
    const timeout = setTimeout(
      () => finish(new Error('Adapter configuration handshake timed out')),
      timeoutMs,
    );
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      total += Buffer.byteLength(chunk, 'utf8');
      if (total > maxBytes) {
        finish(new Error('Adapter configuration payload exceeded size limit'));
        return;
      }
      buffer += chunk;
    });
    process.stdin.once('error', (error) => finish(error));
    process.stdin.once('end', () => {
      try {
        finish(null, JSON.parse(buffer.trim()));
      } catch {
        finish(new Error('Adapter configuration payload must be valid JSON'));
      }
    });
  });
}

function writeReadyError(error) {
  const payload = {
    type: 'error',
    message: error?.safeMessage || error?.message || 'adapter failed to start',
  };
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (writeError) {
    console.error(`[BYOK] failed to write ready error to stdout: ${writeError?.message ?? writeError}`);
  }
  console.error(`[BYOK] adapter start failed: ${payload.message}`);
}

main().catch((error) => {
  writeReadyError(error);
  process.exit(1);
});
