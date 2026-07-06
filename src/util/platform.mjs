import { arch, platform } from 'node:os';

const PLATFORMS = {
  'mac-arm64': {
    url: 'https://downloads.claude.ai/claude-science/latest/mac-arm64.dmg',
    format: 'dmg',
    binaryPath: 'Claude Science.app/Contents/Resources/bin/claude-science',
  },
  'mac-x64': {
    url: 'https://downloads.claude.ai/claude-science/latest/mac-x64.dmg',
    format: 'dmg',
    binaryPath: 'Claude Science.app/Contents/Resources/bin/claude-science',
  },
  'linux-x64': {
    url: 'https://downloads.claude.ai/claude-science/latest/linux-x64',
    format: 'elf',
    binaryPath: null,
  },
};

export function detectPlatform() {
  const os = platform();
  const cpu = arch();
  if (os === 'darwin' && cpu === 'arm64') return 'mac-arm64';
  if (os === 'darwin' && cpu === 'x64')   return 'mac-x64';
  if (os === 'linux'  && cpu === 'x64')   return 'linux-x64';
  return null;
}

export function getPlatformConfig(key) {
  const cfg = PLATFORMS[key];
  if (!cfg) throw Error(`Unknown platform: ${key}. Available: ${Object.keys(PLATFORMS).join(', ')}`);
  return cfg;
}

export function listPlatforms() {
  return Object.keys(PLATFORMS);
}
