# @cometix/cscience

Run [Claude Science](https://claude.com/product/claude-science) locally with your own API key. No OAuth login required.

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
# Optional custom provider, e.g. DeepSeek Anthropic-compatible path:
# ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
```

## Usage

```bash
cscience                        # start server + open browser
cscience serve --port 9000      # custom port
cscience status                 # check daemon + adapter status
cscience stop                   # stop daemon and adapter
```

## Config

`~/.claude-science/byok.env` supports:

| Key | Description |
|-----|-------------|
| `ANTHROPIC_API_KEY` | Provider API key (required unless using auth token) |
| `ANTHROPIC_AUTH_TOKEN` | Alternative: Bearer token |
| `ANTHROPIC_BASE_URL` | Provider Base URL (auto-detects models path and API format) |
| `OPERON_MODELS` | Highest-priority manual model list (skips network discovery) |
| `PORT` | Server port (default: auto) |
| `NO_AUTO_UPDATE` | Set to `1` to skip update checks |

### Advanced troubleshooting

Leave these empty unless auto-detection fails:

| Key | Values | Purpose |
|-----|--------|---------|
| `BYOK_API_FORMAT` | `auto` / `anthropic` / `openai-chat` / `openai-responses` | Force inference protocol |
| `BYOK_MODELS_URL` | full URL | Force models list URL |
| `BYOK_PROVIDER` | `auto` / `deepseek` / `generic` | Force DeepSeek thinking rules |
| `BYOK_REASONING_EFFORT` | `high` / `max` | DeepSeek thinking effort |
| `BYOK_DEBUG` | `0` / `1` | Redacted probe logs (never prints secrets or bodies) |
| `BYOK_ADAPTER` | `1` / `0` | Maintainer-only: `0` disables adapter and uses direct Anthropic credentials |

### Custom Models

```env
# Comma-separated id:name pairs
OPERON_MODELS=claude-sonnet-4-20250514:Sonnet 4,claude-opus-4-20250918:Opus 4

# Or JSON
OPERON_MODELS=[{"id":"claude-sonnet-4-20250514","name":"Sonnet 4"}]
```

## How It Works

On `serve`, the launcher starts a loopback BYOK adapter (`127.0.0.1`, random port) and points Claude Science at it with a synthetic local token. The adapter holds the real provider credentials in memory, discovers `/v1/models` candidates from the Base URL, and converts between Anthropic and OpenAI protocols as needed. DeepSeek thinking mode is normalized (effort, invalid sampling params, and `reasoning_content` round-trip after tool calls).

The package also distributes a patched Claude Science runtime that replaces OAuth-only authentication with API key support. The patcher uses Acorn to parse the minified JS bundle into a full AST, evaluates 14 targeted patch definitions, applies the ones relevant to the upstream build, and validates the output parses cleanly. Required compatibility patches fail the build when absent.

### Security boundaries

- Adapter listens only on loopback.
- Real provider keys never enter the Claude Science child process env when the adapter is enabled.
- State file `~/.claude-science/byok-adapter.json` stores PID/port/local token, launcher leases, daemon ownership, plus non-reversible Base URL, credential, and behavior fingerprints (mode `0600`), never provider secrets or request bodies.
- Concurrent launcher operations share an atomic state lock, so only one managed adapter owns the state file.
- Logs are redacted; `BYOK_DEBUG` still never prints credentials, prompts, thinking, or tool payloads.

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
| P14 | `custom-model-name-filter-disable` | Keep custom provider model names visible |

Patch targeting is AST-based and the complete output is validated with Acorn after application. P14 has an explicit idempotency marker and is required for compatible builds; legacy optional patches remain version-dependent.

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
- An API key from Anthropic or a compatible provider

## Building from Source

```bash
git clone https://github.com/Haleclipse/cscience.git
cd cscience
npm install
npm test                        # unit + integration
npm run test:e2e:mock           # adapter daemon mock E2E
npm run build                   # current platform
npm run build:mac-arm64         # specific platform
npm run build:all               # all platforms
```

Output in `dist/pkg-<platform>/`.

### Verification status

- Unit, integration, and adapter daemon mock E2E tests: automated and passing.
- Full `cscience serve` E2E against a real patched `darwin-arm64` runtime package: not claimed as verified in this change set (requires a full platform build with upstream download).

## License

MIT
