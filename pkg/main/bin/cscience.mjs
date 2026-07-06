#!/usr/bin/env node
import { platform, arch } from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const PLATFORMS = {
  "darwin-arm64": "@cometix/cscience-mac-arm64",
  "darwin-x64":   "@cometix/cscience-mac-x64",
  "linux-x64":    "@cometix/cscience-linux-x64",
};

const key = `${platform()}-${arch()}`;
const alias = PLATFORMS[key];
if (!alias) {
  console.error(`Unsupported platform: ${key}`);
  process.exit(1);
}

let entry;
try {
  entry = require.resolve(alias + "/bin/claude-science.mjs");
} catch {
  console.error(`Platform runtime for ${key} not installed.`);
  console.error(`Try: bun install -g @cometix/cscience`);
  process.exit(1);
}

await import(entry);
