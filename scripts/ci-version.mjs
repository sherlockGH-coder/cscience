#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function resolveCiVersion(env = process.env) {
  if (env.GITHUB_REF?.startsWith('refs/tags/v')) {
    const version = String(env.GITHUB_REF_NAME || '').replace(/^v/, '');
    if (!SEMVER_PATTERN.test(version)) {
      throw new Error(`Invalid release tag version: ${env.GITHUB_REF_NAME || '(missing)'}`);
    }
    return version;
  }

  const runNumber = String(env.GITHUB_RUN_NUMBER || '0');
  if (!/^\d+$/.test(runNumber)) {
    throw new Error(`Invalid GITHUB_RUN_NUMBER: ${runNumber}`);
  }
  return `0.0.0-ci.${runNumber}`;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.stdout.write(`${resolveCiVersion()}\n`);
}
