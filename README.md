<p align="center">
  <img src="logo.png" alt="pi-mem" width="300" />
</p>
<h1 align="center">pi-mem</h1>
<p align="center"><em>surprisingly useful daily memory for the <a href="https://pi.dev/">pi</a> coding agent</em></p>

---

<p align="center"><sub>Inspired by <a href="https://openclaw.ai">OpenClaw</a>'s approach to agent memory.</sub></p>

## Layout

Memory files live under `~/.pi/agent/memory/`:

| File | Purpose |
|------|---------|
| `MEMORY.md` | Curated long-term memory (decisions, preferences, durable facts) |
| `SCRATCHPAD.md` | Checklist of things to keep in mind / fix later |
| `daily/YYYY-MM-DD.md` | Daily append-only log (today + yesterday loaded at session start) |

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to MEMORY.md (`long_term`) or today's daily log (`daily`). Supports `append` and `overwrite` modes. |
| `memory_read` | Read any memory file or list daily logs. |
| `scratchpad` | Manage a checklist: `add`, `done`, `undo`, `clear_done`, `list`. |

## Context Injection

MEMORY.md, SCRATCHPAD.md (open items only), and the last two days of daily logs are automatically injected into the system prompt before every agent turn.

## Dashboard Widget

An auto-generated "Last 24h" summary is shown on session start and switch:
- Scans recent session files for titles, costs, and sub-agent counts
- Groups by topic using an LLM call (falls back to flat list)
- Rebuilt every 15 minutes in the background
- Also shows open scratchpad items

## Installation

Symlink or clone into your pi extensions directory:

```bash
# Clone
git clone https://github.com/skyfallsin/pi-mem.git ~/personal/workspace/pi-mem

# Symlink into pi extensions
ln -sf ~/personal/workspace/pi-mem ~/.pi/agent/extensions/memory
```

Or add as a submodule in your pi-agent-config repo:

```bash
cd ~/.pi/agent
git submodule add https://github.com/skyfallsin/pi-mem.git extensions/memory
```

## License

MIT
