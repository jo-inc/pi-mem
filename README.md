<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/@askjo/pi-mem"><img src="https://img.shields.io/npm/v/@askjo/pi-mem" alt="npm version" /></a>
  <a href="https://github.com/jo-inc/pi-mem/stargazers"><img src="https://img.shields.io/github/stars/jo-inc/pi-mem" alt="GitHub stars" /></a>
</p>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="logo.png" />
    <img src="logo.png" alt="pi-mem" width="300" />
  </picture>
</p>
<h1 align="center">pi-mem</h1>
<p align="center"><em>surprisingly useful daily memory for the <a href="https://pi.dev/">pi</a> coding agent</em></p>
<p align="center"><sub><a href="https://pradeep.md/2026/02/11/pi-mem.html">Read the blog post</a></sub></p>

---

<p align="center"><sub>Inspired by <a href="https://openclaw.ai">OpenClaw</a>'s approach to agent memory.</sub></p>

## Layout

Memory files live under `~/.pi/agent/memory/` (override with `PI_MEMORY_DIR`):

| Path | Purpose |
|------|---------|
| `MEMORY.md` | Curated long-term memory (decisions, preferences, durable facts) |
| `SCRATCHPAD.md` | Checklist of things to keep in mind / fix later |
| `daily/YYYY-MM-DD.md` | Daily append-only log, available on demand |
| `notes/*.md` | LLM-created files (lessons, self-review, reference material, etc.) |

Identity and behavioral files (e.g. `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`) can also live in the memory directory and be injected into context via `PI_CONTEXT_FILES`.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to `long_term` (MEMORY.md), `daily` (today's log), or `note` (notes/filename). Supports `append` and `overwrite` modes. |
| `memory_read` | Read MEMORY.md (`long_term`), SCRATCHPAD.md (`scratchpad`), daily logs (`daily`), notes (`note`), any root file (`file`), or list everything (`list`). |
| `memory_search` | Search across all files — filenames and content. Case-insensitive keyword search across root, notes/, and daily/. |
| `scratchpad` | Manage a checklist: `add`, `done`, `undo`, `clear_done`, `list`. |
| `session_ancestry` | *(opt-in)* Find this thread's ancestor sessions — walks the cross-file `parentSession` chain from the current session up to the root (the sessions it was forked or cloned from), newest first. Read-only. |

## Context Injection

The default `system` mode keeps `MEMORY.md` in a cached system-prompt section, condensed to about 3K tokens (a longer file is hard-cut at a line boundary with an ellipsis and a pointer to `memory_read(target='long_term')`), followed by the recall directive. Per turn it adds one trailing message, only when there is something to say: a retrieval block from other memory files, similar past conversations, and stored facts (capped near 3K tokens; whole items dropped, never fragments, with a `memory_search` pointer when anything was cut), plus today's and yesterday's daily logs with the latest entries kept (2,000-char cap, `memory_read(target='daily')` pointer). The long prompt prefix stays cacheable; only the small trailing message varies.

Other modes:

- `bootstrap` — a per-turn recall block including `MEMORY.md` itself, injected as a user message every turn (no cached section)
- `full` — inject context files, `MEMORY.md`, today's and yesterday's logs, and catchup indexes every turn
- `off` — inject nothing

`SCRATCHPAD.md`, files in `notes/`, and older daily logs are always available on demand through the memory tools.

## Session Ancestry (opt-in)

Pi records session lineage but offers no easy way to read it: a forked or cloned session stores a `parentSession` path in its JSONL header, and entries within one session link via `parentId`. An agent only gets `PI_SESSION_FILE` at runtime, so it has no simple way to answer "what threads am I descended from?"

When enabled (`PI_ANCESTRY=1` or `"ancestry": true` in `.pi-mem.json`), pi-mem registers:

- a model-callable `session_ancestry` tool that walks the cross-file `parentSession` chain from the current session up to the root, newest first, and can optionally summarize the current branch's in-thread `parentId` lineage; and
- an `/ancestry` command that prints the same chain for you.

Both are read-only and guard against cycles, missing files, and runaway chains. The feature is **off by default**, so it adds no tools or context unless you turn it on.

## Configuration

Settings can be configured via environment variables or a `.pi-mem.json` file in the memory directory. Environment variables take precedence over file values.

### .pi-mem.json

Place a `.pi-mem.json` in your memory directory (default `~/.pi/agent/memory/.pi-mem.json`):

```json
{
  "searchDirs": ["catchup", "projects"],
  "contextFiles": ["SOUL.md", "AGENTS.md"],
  "contextMode": "system",
  "autocommit": true,
  "ancestry": false
}
```

### Environment variables

Environment variables override `.pi-mem.json` values when set.

| Env Var | Default | Description |
|---------|---------|-------------|
| `PI_MEMORY_DIR` | `~/.pi/agent/memory/` | Root directory for all memory files |
| `PI_DAILY_DIR` | `$PI_MEMORY_DIR/daily/` | Directory for daily logs |
| `PI_CONTEXT_FILES` | *(empty)* | Comma-separated extra files used by `full` context mode |
| `PI_SEARCH_DIRS` | *(empty)* | Comma-separated list of subdirectories (relative to `PI_MEMORY_DIR`) to include in `memory_search`. Searched recursively one level deep. (e.g. `catchup,projects`) |
| `PI_AUTOCOMMIT` | `false` | When `1` or `true`, auto-commit to git after every write |
| `PI_MEMORY_CONTEXT_MODE` | `system` | Context mode: `system`, `bootstrap`, `full`, or `off` |
| `PI_ANCESTRY` | `false` | When `1` or `true`, registers the `session_ancestry` tool and `/ancestry` command. Off by default. |
| `PI_TIMEZONE` | `TZ`, then `UTC` | IANA timezone used for daily log filenames and today/yesterday context windows. Invalid values fall back to `UTC`. |

## Dashboard Widget

An auto-generated "Last 24h" summary is shown on session start and switch:
- Scans recent session files for titles, costs, and sub-agent counts
- Groups by topic using an LLM call (falls back to flat list)
- Rebuilt every 15 minutes in the background
- Also shows open scratchpad items

## Related

- **[pi-reflect](https://github.com/jo-inc/pi-reflect)** — Self-improving reflection engine for pi. Analyzes recent conversations and iterates on memory, behavioral rules, and identity files. Pairs naturally with pi-mem.

## Installation

```bash
pi install git:github.com/jo-inc/pi-mem
```

## License

MIT

## Pi Ecosystem

| Package | Description |
|---------|-------------|
| [pi-reflect](https://github.com/jo-inc/pi-reflect) | Self-improving behavioral files |
| [pi-boss](https://github.com/skyfallsin/pi-boss) | Multi-agent orchestration via tmux |
| [pi-room](https://github.com/skyfallsin/pi-room) | Multi-agent awareness and coordination |
| [pi-vertex-anthropic](https://github.com/skyfallsin/pi-vertex-anthropic) | Claude via Google Cloud Vertex AI |
| [pi-skill-posthog](https://github.com/skyfallsin/pi-skill-posthog) | PostHog analytics skill for pi agents |
