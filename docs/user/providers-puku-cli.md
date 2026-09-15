# Puku CLI

T3 Code can drive [puku-cli](https://www.npmjs.com/package/@puku/puku-cli) as a
provider. Puku CLI is a near-clone of Claude Code CLI: it speaks the same
`stream-json` wire format, the same `--print` flag surface, the same resume /
permission / tool-calling semantics, and routes to the same Anthropic backend by
default. The Puku CLI provider is shipped under a `Preview` badge because the
driver is structurally a Claude driver with two extra CLI deltas documented
below.

Start with [provider setup](./install.md#providers) if you have not yet added a
provider instance in **Settings > Providers**.

## Install puku-cli

```bash
bun add -g @puku/puku-cli
# or: npm i -g @puku/puku-cli
```

Confirm the install:

```bash
puku-cli --version
```

T3 Code expects a binary named `puku-cli` on `PATH` (or the absolute path you
set under **Binary path** in the provider instance). The **Update channel**
button uses the npm registry — the same update path Claude uses — so a globally
installed package is updatable in one click.

## Authenticate

```bash
puku-cli auth login
```

Subscription login stores its session in `~/.puku-cli/` by default; an API-key
login stores the key in the same directory. After login, the Puku CLI provider
instance should report `Authenticated` and the account email in **Settings >
Providers**. If the snapshot reports `Unauthenticated` or `Unknown`, run
`puku-cli auth status` on the environment's machine to see what puku-cli
itself reports.

## Two CLI deltas vs. Claude

1. **`--permission-mode auto`** — Claude Code's `--permission-mode` enum does
   not include `auto`. Puku CLI adds it; the driver preserves whatever you
   selected in the thread when forwarding `--permission-mode`.
2. **`--bare`** — Puku CLI's `--bare` flag skips hooks, LSP, plugin sync,
   auto-memory, and `CLAUDE.md` auto-discovery. Enable it for server-side /
   sandboxed runs where you do not want those side effects. The driver exposes
   this as the **Bare mode** toggle on the provider instance.

## Separate accounts or configurations

Each instance can carry its own home directory. puku-cli auto-detects
`~/.puku-cli/`; leaving the **Puku config dir** field empty inherits that
default. Setting a custom path is the only way to isolate two instances on the
same machine (so that subscription state, conversation history, and MCP
registrations do not bleed across).

```bash
mkdir -p ~/.puku_personal
puku-cli --settings ~/.puku_personal auth login
```

Add a second Puku CLI instance in **Settings > Providers**:

| Instance        | Binary path | Puku config dir     |
| --------------- | ----------- | ------------------- |
| Puku CLI Work   | `puku-cli`  | Leave empty         |
| Puku Personal   | `puku-cli`  | `~/.puku_personal`  |

The driver forwards the **Puku config dir** as `--settings <path>` so that
puku-cli sees a per-instance root without forcing `HOME` relocation (which
would relocate the macOS keychain entry as well).

Existing threads can switch only between Puku CLI instances with the same
config dir. Separate config dirs stay isolated, including their local
conversation state.

## Launch arguments

The **Launch arguments** field on the instance forwards extra flags on every
`puku-cli` invocation (chat, resume, and text generation). Quote segments
with spaces, e.g. `--add-dir "/path with spaces"`. Anything you would put in a
shell command works here.

For presets that differ only in API keys, base URLs, or model aliases, prefer
the instance's **Environment variables** rather than launch arguments.

## Bare mode

Toggle **Bare mode** on the instance when you want to skip hooks, LSP, plugin
sync, auto-memory, and `CLAUDE.md` auto-discovery. This is recommended for
server-side runs where those side effects are not desired. Bare mode is a
per-instance setting; chat and text-generation runs both honor it.

## Compact long conversations

Set **Auto-compact after** in the provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks puku-cli to summarize at
about 300,000 tokens. This changes when compaction happens, not the model's
context window. Leave it empty for puku-cli's default.

You can also send `/compact` in an existing conversation. Web and desktop
offer **Compact context** from the context meter and may suggest it when you
return to a large older thread. See [commands and skills](./composer.md#commands-and-skills)
for using composer commands.

## OpenRouter

Create a Puku CLI instance with its own config dir (such as `~/.puku_openrouter`)
and keep **Binary path** set to `puku-cli`. In that instance's **Environment
variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Puku config dir has a cached Anthropic-style login, run `puku-cli
auth logout` in a puku-cli session using that directory before starting the
router setup. Cached login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the
built-in list, open that Puku CLI instance in **Settings > Providers** and add
its full model ID with **Add custom model**. Then select it in the chat model
picker.

## Other routers

A local router uses an ordinary Puku CLI provider instance. Give it a separate
config dir and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it.

## Update channel

**Settings > Providers > [instance] > Check for updates** queries the npm
registry for `@puku/puku-cli` and uses `puku-cli update` for installs that
land in `~/.bun/install/global/node_modules/@puku/puku-cli/` or the local bin
directories. Manual installs elsewhere still surface the version gap but stay
manual-only.
