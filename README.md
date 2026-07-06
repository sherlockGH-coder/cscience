# @cometix/cscience

Run [Claude Science](https://claude.com/product/claude-science) locally with your own Anthropic API key. No OAuth login required.

## Install

```bash
bun install -g @cometix/cscience
```

## Setup

First run creates `~/.claude-science/byok.env`:

```bash
cscience
# → Config created: ~/.claude-science/byok.env
# → Edit it to set your ANTHROPIC_API_KEY, then re-run.
```

Edit the config:

```bash
vim ~/.claude-science/byok.env
```

```env
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
```

## Usage

```bash
cscience                        # start server + open browser
cscience serve --port 9000      # custom port
cscience status                 # check daemon status
cscience stop                   # stop daemon
```

## Config

`~/.claude-science/byok.env` supports:

| Key | Description |
|-----|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required) |
| `ANTHROPIC_AUTH_TOKEN` | Alternative: OAuth bearer token |
| `ANTHROPIC_BASE_URL` | Custom API endpoint / proxy |
| `OPERON_MODELS` | Custom model list (see below) |
| `PORT` | Server port (default: auto) |
| `NO_AUTO_UPDATE` | Set to `1` to skip update checks |

### Custom Models

```env
# Comma-separated id:name pairs
OPERON_MODELS=claude-sonnet-4-20250514:Sonnet 4,claude-opus-4-20250918:Opus 4

# Or JSON
OPERON_MODELS=[{"id":"claude-sonnet-4-20250514","name":"Sonnet 4"}]
```

## How It Works

This package distributes a patched build of Claude Science that replaces OAuth-only authentication with API key support. The patcher uses Acorn to parse the ~9MB minified JS bundle into a full AST, applies 13 targeted patches, and validates the output parses cleanly.

### Patches

| ID | Name | What it does |
|----|------|-------------|
| P1 | `oauth-gate-bypass` | Accept API key when OAuth token is absent |
| P2 | `credential-resolver-env` | Fall back to `ANTHROPIC_API_KEY` env var |
| P3 | `https-enforcement-relaxed` | Allow HTTP base URL for local proxies |
| P4 | `auth-status-bypass` | Return `authenticated: true` without OAuth |
| P5 | `growthbook-flags-hardcode` | Enable feature flags without GrowthBook |
| P6 | `models-error-downgrade` | Show default models instead of auth error |
| P7 | `provider-restriction-remove` | Remove anthropic-only provider check |
| P8 | `operon-models-env` | Support `OPERON_MODELS` env var |
| P9 | `model-filter-disable` | Remove `claude-` prefix requirement |
| P10 | `fable-filter-disable` | Remove fable/mythos model series block |
| P11 | `pid-daemon-recognition` | Recognize `.js`/`.ts` in process detection |
| P12 | `disable-require-token` | Remove `require_token` build guard |
| P13 | `require-token-default-false` | Default `require_token` to `false` |

All patches are AST-based (no regex/string matching), idempotent, and validated against Acorn after application.

## Package Structure

One package name, platform runtimes published as version suffixes with dist-tags:

```
@cometix/cscience@0.1.0                 latest (meta)
@cometix/cscience@0.1.0-mac-arm64       macOS ARM
@cometix/cscience@0.1.0-mac-x64         macOS Intel
@cometix/cscience@0.1.0-linux-x64       Linux x64
```

`bun install -g @cometix/cscience` automatically pulls the correct platform runtime via `optionalDependencies` with `npm:` aliases.

## Requirements

- [Bun](https://bun.sh) >= 1.1.0
- An [Anthropic API key](https://console.anthropic.com/)

## Building from Source

```bash
git clone https://github.com/Haleclipse/cscience.git
cd cscience
npm install
npm run build                   # current platform
npm run build:mac-arm64         # specific platform
npm run build:all               # all platforms
```

Output in `dist/pkg-<platform>/`.

## License

MIT
