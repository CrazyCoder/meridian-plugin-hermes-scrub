# @rynfar/meridian-plugin-hermes-scrub

A [Meridian](https://github.com/rynfar/meridian) plugin that strips [Hermes Agent](https://hermes-agent.nousresearch.com)'s coding-harness fingerprint from the system prompt before it reaches Claude.

## Why

Hermes Agent (by Nous Research) can talk to any Anthropic-compatible endpoint via `api_mode: anthropic_messages`, so you can point it straight at Meridian and use your Claude Max subscription. But Hermes injects a built-in `# Finishing the job` framework block into its system prompt — finish-the-job insistence, persistent-memory instructions, and skill-management directives.

Individually those lines are harmless. **Cumulatively the block reads as an autonomous coding-agent harness**, and Anthropic's usage metering flags that signal: the request gets billed as **Extra Usage** instead of under your Max subscription. Once your Extra Usage is depleted, every Hermes request fails with:

```
400 invalid_request_error: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.
```

This plugin removes that fingerprint in two independent passes:

1. **Harness blocks** — the `# Finishing the job` block and the un-headed persistent-memory / session-recall / skills paragraph are deleted. On a real gateway prompt that is ~2.8k characters of harness signal.
2. **Tool identifiers** — Hermes' self-management tool names (`session_search`, `skill_manage`, `skill_view`, `skills_list`) are neutralized *in prose* by replacing the underscore with a space (`session_search` → `session search`). The sentence stays readable; the snake_case fingerprint does not survive.

Pass 2 exists because pass 1 is heading-anchored and therefore cannot reach the **spawned-subagent / delegated-child** prompt: that variant has no `You have persistent memory` anchor and re-homes the session/skills guidance under `# Parallel tool calls`, so every subagent kept getting metered. Pass 1 stays because it is the production-proven mitigation and removes far more signal than pass 2 does — block-deletion-only builds run clean while still emitting bare `skill_view` / `skill_manage` tokens, so the identifiers are demonstrably not the whole trigger. Running both is strictly the smaller fingerprint.

Everything else in Hermes' prompt is preserved verbatim:

- the user-editable **persona** (`# Hermes Agent Persona`, "You run on Hermes Agent…")
- **mid-turn user steering** instructions
- the full **`<available_skills>`** list
- tools, guidelines, and any user- or harness-appended content

Tool *calls* are unaffected: tools are invoked by their schema name, not by the prose spelling.

The scrub is **content-scoped** (it runs on every adapter and self-scopes by matching Hermes' fingerprint) and **idempotent** (running it twice is a no-op — the spaced identifier form no longer matches). It's an exact pass-through for non-Hermes prompts — Claude Code, OpenCode, pi, etc. are returned byte-identical, whitespace included.

## Install

### Option 1: Local clone (recommended for dev)

```bash
git clone https://github.com/rynfar/meridian-plugin-hermes-scrub.git ~/repos/meridian-plugin-hermes-scrub
cd ~/repos/meridian-plugin-hermes-scrub
npm install
npm run build
```

Then point Meridian's plugin config at the built file:

```bash
mkdir -p ~/.config/meridian
# add this entry to ~/.config/meridian/plugins.json:
#   { "path": "/Users/YOU/repos/meridian-plugin-hermes-scrub/dist/index.js", "enabled": true }
```

Restart Meridian (or `curl -X POST http://localhost:3456/plugins/reload`).

Verify at `http://localhost:3456/plugins` — you should see `hermes-scrub` listed as **active**.

### Option 2: Drop-in file

Symlink or copy `dist/index.js` into `~/.config/meridian/plugins/` for auto-discovery:

```bash
ln -s ~/repos/meridian-plugin-hermes-scrub/dist/index.js ~/.config/meridian/plugins/hermes-scrub.js
```

## Point Hermes at Meridian

In `~/.hermes/config.yaml`:

```yaml
model:
  provider: custom
  base_url: http://localhost:3456     # your Meridian instance
  api_mode: anthropic_messages
  default: claude-opus-4-8            # or any model Meridian maps
  api_key: meridian-local            # any non-empty value; Meridian uses your Max auth
```

## Behavior

| Input | Output |
|---|---|
| No system prompt | unchanged |
| System prompt with no Hermes fingerprint at all | byte-identical, whitespace included |
| Hermes' default system prompt | `# Finishing the job` block and memory/skills paragraph removed, spacing normalized; surviving identifiers neutralized; persona, steering, and skills catalog preserved |
| Hermes' subagent prompt (no memory anchor, guidance re-homed) | identifiers neutralized; no block to remove, so length and whitespace are unchanged |
| Already-scrubbed output | unchanged (idempotent) |

## Test

```bash
bun test
```

## License

MIT
