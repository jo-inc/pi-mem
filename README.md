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
| `daily/YYYY-MM-DD.md` | Daily append-only log (today + yesterday loaded at session start) |
| `notes/*.md` | LLM-created files (lessons, self-review, reference material, etc.) |

Identity and behavioral files (e.g. `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`) can also live in the memory directory and be injected into context via `PI_CONTEXT_FILES`.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to `long_term` (MEMORY.md), `daily` (today's log), or `note` (notes/filename). Supports `append` and `overwrite` modes. |
| `memory_read` | Read MEMORY.md (`long_term`), SCRATCHPAD.md (`scratchpad`), daily logs (`daily`), notes (`note`), any root file (`file`), or list everything (`list`). |
| `memory_search` | Search across all files — filenames and content. Case-insensitive keyword search across root, notes/, and daily/. |
| `scratchpad` | Manage a checklist: `add`, `done`, `undo`, `clear_done`, `list`. |

## Context Injection

The following are automatically injected into the system prompt before every agent turn:

- Files listed in `PI_CONTEXT_FILES` (e.g. `SOUL.md,AGENTS.md,HEARTBEAT.md`)
- `MEMORY.md`
- `SCRATCHPAD.md` (open items only)
- Today's and yesterday's daily logs

Files in `notes/` and older daily logs are **not** injected — they're accessible on-demand via `memory_search` and `memory_read`.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PI_MEMORY_DIR` | `~/.pi/agent/memory/` | Root directory for all memory files |
| `PI_DAILY_DIR` | `$PI_MEMORY_DIR/daily/` | Directory for daily logs |
| `PI_CONTEXT_FILES` | *(empty)* | Comma-separated list of extra files to inject into context (e.g. `SOUL.md,AGENTS.md,HEARTBEAT.md`) |
| `PI_AUTOCOMMIT` | `false` | When `1` or `true`, auto-commit to git after every write |

## Dashboard Widget

An auto-generated "Last 24h" summary is shown on session start and switch:
- Scans recent session files for titles, costs, and sub-agent counts
- Groups by topic using an LLM call (falls back to flat list)
- Rebuilt every 15 minutes in the background
- Also shows open scratchpad items

## Installation

```bash
pi install git:github.com/skyfallsin/pi-mem
```

## License

MIT
