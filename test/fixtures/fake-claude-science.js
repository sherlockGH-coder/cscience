#!/usr/bin/env bun

import { existsSync, writeFileSync } from 'node:fs';

const command = process.argv[2];

if (process.env.FAKE_RUNTIME_ENV_OUTPUT) {
  writeFileSync(
    process.env.FAKE_RUNTIME_ENV_OUTPUT,
    `${JSON.stringify({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
      cwd: process.cwd(),
      pwd: process.env.PWD ?? null,
    })}\n`,
  );
}

if (command === 'serve') {
  process.stdout.write('[fake-runtime] ready\n');
  const exitAfterMs = Number(process.env.FAKE_RUNTIME_EXIT_AFTER_MS || 0);
  if (exitAfterMs > 0) {
    setTimeout(() => {
      if (
        process.env.FAKE_RUNTIME_DAEMONIZE === '1' &&
        process.env.FAKE_RUNTIME_DAEMON_STATE
      ) {
        writeFileSync(process.env.FAKE_RUNTIME_DAEMON_STATE, `${process.pid}\n`);
      }
      process.exit(Number(process.env.FAKE_RUNTIME_EXIT_CODE || 0));
    }, exitAfterMs);
  } else {
    const keepAlive = setInterval(() => {}, 1000);
    const shutdown = () => {
      clearInterval(keepAlive);
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} else if (command === 'status') {
  const statePath = process.env.FAKE_RUNTIME_DAEMON_STATE;
  process.exit(statePath && existsSync(statePath) ? 0 : 1);
} else {
  process.exit(0);
}
