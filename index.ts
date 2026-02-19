/**
 * Memory Extension
 *
 * Plain-Markdown memory system inspired by OpenClaw's approach.
 * No embeddings, no vector search — just files on disk injected into context.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *
 * Tools:
 *   memory_write  — write to MEMORY.md or daily log
 *   memory_read   — read any memory file or list daily logs
 *   scratchpad    — add/check/uncheck/clear items on the scratchpad checklist
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 *
 * Dashboard widget:
 *   - Auto-generated "Last 24h" summary from session metadata (titles, timestamps, costs)
 *   - Rebuilt every 15 minutes in the background
 *   - Shown on session_start and session_switch (so /new gets it too)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum, completeSimple, getModel } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
	type MemoryConfig,
	type ScratchpadItem,
	type SessionInfo,
	buildConfig,
	todayStr,
	yesterdayStr,
	nowTimestamp,
	shortSessionId,
	readFileSafe,
	dailyPath,
	ensureDirs,
	parseScratchpad,
	serializeScratchpad,
	buildMemoryContext,
	scanSession,
	isHousekeeping,
	searchMemory,
} from "./lib.ts";

const config = buildConfig();

function gitCommit(message: string) {
	if (!config.autocommit) return;
	try {
		execFileSync("git", ["add", "-A"], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
		execFileSync("git", ["commit", "-m", message, "--allow-empty-message", "--no-verify"], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
	} catch {
		// git not available or not a repo — silently skip
	}
}

// --- Session scanner for "Last 24h" dashboard ---

const SESSIONS_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
const SUMMARY_CACHE = path.join(config.dailyDir, "cache.json");
const REBUILD_INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

let modelRegistryRef: any = null;

async function collectSessions(): Promise<{ roots: SessionInfo[]; childCountMap: Map<string, number>; totalCost: number }> {
	const cutoff = new Date(Date.now() - LOOKBACK_MS);
	const sessionDirs: string[] = [];

	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.startsWith("--Users-") && !dir.includes("-T-pi-")) {
				sessionDirs.push(path.join(SESSIONS_DIR, dir));
			}
		}
	} catch { return { roots: [], childCountMap: new Map(), totalCost: 0 }; }

	const recentFiles: string[] = [];
	for (const dir of sessionDirs) {
		try {
			for (const file of fs.readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const filePath = path.join(dir, file);
				try {
					if (fs.statSync(filePath).mtime >= cutoff) recentFiles.push(filePath);
				} catch { continue; }
			}
		} catch { continue; }
	}

	if (recentFiles.length === 0) return { roots: [], childCountMap: new Map(), totalCost: 0 };

	const results = await Promise.all(recentFiles.map(scanSession));
	const sessions = results.filter((s): s is SessionInfo => s !== null);

	const roots = sessions.filter(s => !s.isChild);
	const children = sessions.filter(s => s.isChild);

	const childCountMap = new Map<string, number>();
	for (const child of children) {
		if (child.parentSession) {
			childCountMap.set(child.parentSession, (childCountMap.get(child.parentSession) || 0) + 1);
		}
	}

	const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
	return { roots, childCountMap, totalCost };
}

async function summarizeWithLLM(sessions: SessionInfo[], childCountMap: Map<string, number>, totalCost: number): Promise<string> {
	if (!modelRegistryRef) return "";

	const candidates = [
		getModel("openai", "gpt-4.1-mini"),
		getModel("openai", "gpt-4o-mini"),
		modelRegistryRef.find("jo-proxy", "jo-gpt-4.1-mini"),
	];

	let model: any = null;
	let apiKey: string | undefined;
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = await modelRegistryRef.getApiKey(candidate);
		if (key) { model = candidate; apiKey = key; break; }
	}
	if (!model || !apiKey) return "";

	const listing = sessions.map((s, _i) => {
		const childCount = childCountMap.get(s.file) || 0;
		const parts = [`${s.title}`];
		if (childCount > 0) parts.push(`[${childCount} sub-agents]`);
		if (s.cost > 0.05) parts.push(`[$${s.cost.toFixed(2)}]`);
		return parts.join(" ");
	}).join("\n");

	const response = await completeSimple(model, {
		systemPrompt: [
			"You are summarizing a developer's last 24 hours of coding sessions for a dashboard.",
			"Write a concise grouped summary in markdown. Rules:",
			"",
			"- Group by TOPIC (not time). 3-7 groups. Short bold header per group (2-4 words).",
			"- Under each header, write 1-3 bullet points summarizing WHAT WAS ACCOMPLISHED.",
			"  Synthesize multiple related sessions into a single clear statement.",
			"  e.g. 10 sessions about 'Run eval suite X' → '**Eval suite runs**: ran all 10 suites in sprite mode across weather, routing, memory, calendar, email, browser, and security'",
			"- Be specific about outcomes: fixes applied, features built, bugs found, tools created.",
			"- Collapse repetitive runs (eval runs, debugging attempts) into one line with the count.",
			"- Mention sub-agent counts where relevant — it shows parallel work.",
			"- Keep total output under 25 lines. Dense and useful, not a laundry list.",
			"- Order: oldest topic first, most recent topic last.",
			"- Do NOT include a header line — the caller adds that.",
			"- Do NOT repeat session titles verbatim. Summarize.",
		].join("\n"),
		messages: [{
			role: "user" as const,
			content: [{ type: "text" as const, text: `${sessions.length} sessions, $${totalCost.toFixed(2)} total cost:\n\n${listing}` }],
			timestamp: Date.now(),
		}],
	}, { apiKey });

	return response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();
}

async function buildSessionSummary(): Promise<string> {
	const { roots, childCountMap, totalCost } = await collectSessions();
	if (roots.length === 0) return "";

	const sorted = [...roots]
		.filter(s => !isHousekeeping(s.title))
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	if (sorted.length === 0) return "";

	const header = `## Last 24h — ${sorted.length} sessions, $${totalCost.toFixed(2)}`;

	try {
		const summary = await summarizeWithLLM(sorted, childCountMap, totalCost);
		if (summary) return `${header}\n\n${summary}`;
	} catch {}

	const lines = [header, ""];
	for (const s of sorted) {
		const childCount = childCountMap.get(s.file) || 0;
		const childTag = childCount > 0 ? ` (+${childCount} sub-agents)` : "";
		lines.push(`- ${s.title}${childTag}`);
	}
	return lines.join("\n");
}

let cachedSummary = "";
let lastRebuildTime = 0;

async function getOrRebuildSummary(): Promise<string> {
	const now = Date.now();
	if (now - lastRebuildTime < REBUILD_INTERVAL_MS && cachedSummary) {
		return cachedSummary;
	}

	if (!cachedSummary) {
		try {
			const cache = JSON.parse(fs.readFileSync(SUMMARY_CACHE, "utf-8"));
			if (cache.summary && now - cache.timestamp < REBUILD_INTERVAL_MS) {
				cachedSummary = cache.summary;
				lastRebuildTime = cache.timestamp;
				return cachedSummary;
			}
		} catch {}
	}

	cachedSummary = await buildSessionSummary();
	lastRebuildTime = now;

	try {
		ensureDirs(config);
		fs.writeFileSync(SUMMARY_CACHE, JSON.stringify({ summary: cachedSummary, timestamp: now }), "utf-8");
	} catch {}

	return cachedSummary;
}

export default function (pi: ExtensionAPI) {
	let rebuildTimer: ReturnType<typeof setInterval> | null = null;

	async function showDashboard(ctx: any) {
		if (!ctx.hasUI) return;

		const summary = await getOrRebuildSummary();
		const scratchContent = readFileSafe(config.scratchpadFile);

		// Parse scratchpad items
		const openItems: string[] = [];
		if (scratchContent?.trim()) {
			const lines = scratchContent.trim().split("\n");
			for (const l of lines) {
				if (l.match(/^- \[ \]/) && !l.match(/^<!--.*-->$/)) {
					openItems.push(l.replace(/^- /, ""));
				}
			}
		}

		if (!summary && openItems.length === 0) return;

		ctx.ui.setWidget("memory-dashboard", (_tui: any, theme: any) => {
			const mdTheme = getMarkdownTheme();
			const container = new Container();
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			let lastExpanded: boolean | undefined;

			const origRender = container.render.bind(container);
			container.render = (width: number) => {
				const expanded = ctx.ui.getToolsExpanded();

				if (cachedLines && cachedWidth === width && lastExpanded === expanded) {
					return cachedLines;
				}

				container.clear();

				if (expanded) {
					if (summary) {
						container.addChild(new Markdown(summary, 1, 0, mdTheme));
					}
					if (openItems.length > 0) {
						if (summary) container.addChild(new Spacer(1));
						const scratchMd = `## Scratchpad\n\n${openItems.join("\n")}`;
						container.addChild(new Markdown(scratchMd, 1, 0, mdTheme));
					}
				} else {
					const parts: string[] = [];
					if (summary) {
						const costMatch = summary.match(/\$[\d.]+/);
						const cost = costMatch ? costMatch[0] : "";
						const sessMatch = summary.match(/(\d+) sessions/);
						const sessions = sessMatch ? sessMatch[1] : "0";
						parts.push(`Last 24h: ${cost}, ${sessions} log entries`);
					}
					if (openItems.length > 0) {
						parts.push(`${openItems.length} scratchpad item${openItems.length > 1 ? "s" : ""}`);
					}
					const hint = keyHint("expandTools", "to expand");
					const line = theme.fg("muted", parts.join(", ")) + " " + theme.fg("dim", `(${hint})`);
					container.addChild(new Text(line, 1, 0));
				}

				cachedLines = origRender(width);
				cachedWidth = width;
				lastExpanded = expanded;
				return cachedLines;
			};

			const origInvalidate = container.invalidate.bind(container);
			container.invalidate = () => {
				cachedWidth = undefined;
				cachedLines = undefined;
				lastExpanded = undefined;
				origInvalidate();
			};

			return container;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
		await showDashboard(ctx);

		if (!rebuildTimer) {
			rebuildTimer = setInterval(async () => {
				cachedSummary = await buildSessionSummary();
				lastRebuildTime = Date.now();
				try {
					ensureDirs(config);
					fs.writeFileSync(SUMMARY_CACHE, JSON.stringify({ summary: cachedSummary, timestamp: lastRebuildTime }), "utf-8");
				} catch {}
			}, REBUILD_INTERVAL_MS);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
		await showDashboard(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		ctx.ui.setWidget("memory-dashboard", undefined);
	});

	pi.on("session_shutdown", async () => {
		if (rebuildTimer) { clearInterval(rebuildTimer); rebuildTimer = null; }
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const memoryContext = buildMemoryContext(config);
		if (!memoryContext) return;

		const memoryInstructions = [
			"\n\n## Memory",
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts \u2192 MEMORY.md",
			"- Day-to-day notes and running context \u2192 daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind \u2192 scratchpad tool",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + memoryInstructions,
		};
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		const memoryContext = buildMemoryContext(config);
		const hasMemory = memoryContext.length > 0;

		if (hasMemory) {
			ctx.ui.notify("Memory files available \u2014 consider persisting important context before compaction", "info");
		}
	});

	// memory_write tool
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Three targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"- 'note': Create or update a file in notes/ (e.g. lessons.md, self-review.md). Pass filename. Mode: 'append' or 'overwrite'.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily", "note"] as const, {
				description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log, 'note' for notes/<filename>",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "Write mode. Default: 'append'. Daily always appends.",
				}),
			),
			filename: Type.Optional(
				Type.String({ description: "Filename for 'note' target (e.g. 'lessons.md')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs(config);
			const { target, content, mode, filename } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "note") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'note'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(config.notesDir, safe);
				const existing = readFileSafe(filePath) ?? "";

				if (mode === "overwrite") {
					const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
					fs.writeFileSync(filePath, stamped, "utf-8");
					gitCommit(`note: ${safe}`);
					return {
						content: [{ type: "text", text: `Wrote notes/${safe}` }],
						details: { path: filePath, target, mode: "overwrite", sessionId: sid, timestamp: ts },
					};
				}

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				gitCommit(`note: ${safe}`);
				return {
					content: [{ type: "text", text: `Appended to notes/${safe}` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts },
				};
			}

			if (target === "daily") {
				const filePath = dailyPath(config.dailyDir, todayStr());
				const existing = readFileSafe(filePath) ?? "";

				const existingSnippet = existing.trim()
					? `\n\nExisting daily log content:\n${existing.trim()}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				gitCommit(`daily: ${todayStr()}`);
				return {
					content: [{ type: "text", text: `Appended to daily log: ${filePath}${existingSnippet}` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts },
				};
			}

			// long_term
			const existing = readFileSafe(config.memoryFile) ?? "";
			const existingSnippet = existing.trim()
				? `\n\nExisting MEMORY.md content:\n${existing.trim()}`
				: "\n\nMEMORY.md was empty.";

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(config.memoryFile, stamped, "utf-8");
				gitCommit("memory: overwrite");
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: { path: config.memoryFile, target, mode: "overwrite", sessionId: sid, timestamp: ts },
				};
			}

			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			fs.writeFileSync(config.memoryFile, existing + separator + stamped, "utf-8");
			gitCommit("memory: append");
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: { path: config.memoryFile, target, mode: "append", sessionId: sid, timestamp: ts },
			};
		},
	});

	// scratchpad tool
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({ description: "Item text for add, or substring to match for done/undo" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs(config);
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(config.scratchpadFile) ?? "";
			let items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return { content: [{ type: "text", text: "Scratchpad is empty." }], details: {} };
				}
				return {
					content: [{ type: "text", text: serializeScratchpad(items) }],
					details: { count: items.length, open: items.filter((i) => !i.done).length },
				};
			}

			if (action === "add") {
				if (!text) {
					return { content: [{ type: "text", text: "Error: 'text' is required for add." }], details: {} };
				}
				items.push({ done: false, text, meta: `<!-- ${ts} [${sid}] -->` });
				fs.writeFileSync(config.scratchpadFile, serializeScratchpad(items), "utf-8");
				gitCommit(`scratchpad: add`);
				return {
					content: [{ type: "text", text: `Added: - [ ] ${text}\n\n${serializeScratchpad(items)}` }],
					details: { action, sessionId: sid, timestamp: ts },
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return { content: [{ type: "text", text: `Error: 'text' is required for ${action}.` }], details: {} };
				}
				const needle = text.toLowerCase();
				const targetDone = action === "done";
				let matched = false;
				for (const item of items) {
					if (item.done !== targetDone && item.text.toLowerCase().includes(needle)) {
						item.done = targetDone;
						matched = true;
						break;
					}
				}
				if (!matched) {
					return {
						content: [{ type: "text", text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"` }],
						details: {},
					};
				}
				fs.writeFileSync(config.scratchpadFile, serializeScratchpad(items), "utf-8");
				gitCommit(`scratchpad: ${action}`);
				return {
					content: [{ type: "text", text: `Updated.\n\n${serializeScratchpad(items)}` }],
					details: { action, sessionId: sid, timestamp: ts },
				};
			}

			if (action === "clear_done") {
				const before = items.length;
				items = items.filter((i) => !i.done);
				const removed = before - items.length;
				fs.writeFileSync(config.scratchpadFile, serializeScratchpad(items), "utf-8");
				gitCommit("scratchpad: clear_done");
				return {
					content: [{ type: "text", text: `Cleared ${removed} done item(s).\n\n${serializeScratchpad(items)}` }],
					details: { action, removed },
				};
			}

			return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {} };
		},
	});

	// memory_read tool
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'file': Read any file by name (e.g. 'SOUL.md'). Pass filename.",
			"- 'note': Read a file from notes/ (e.g. 'lessons.md'). Pass filename.",
			"- 'list': List all files in the memory directory.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "file", "note", "list"] as const, {
				description: "What to read",
			}),
			date: Type.Optional(
				Type.String({ description: "Date for daily log (YYYY-MM-DD). Default: today." }),
			),
			filename: Type.Optional(
				Type.String({ description: "Filename for 'file' target (e.g. 'lessons.md', 'SOUL.md')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs(config);
			const { target, date, filename } = params;

			if (target === "list") {
				const sections: string[] = [];
				try {
					const rootFiles = fs.readdirSync(config.memoryDir).filter(f => f.endsWith(".md") || f.endsWith(".json")).sort();
					if (rootFiles.length > 0) sections.push(`Files:\n${rootFiles.map(f => `- ${f}`).join("\n")}`);
				} catch {}
				try {
					const noteFiles = fs.readdirSync(config.notesDir).filter(f => f.endsWith(".md")).sort();
					if (noteFiles.length > 0) sections.push(`Notes:\n${noteFiles.map(f => `- notes/${f}`).join("\n")}`);
				} catch {}
				try {
					const dailyFiles = fs.readdirSync(config.dailyDir).filter(f => f.endsWith(".md")).sort().reverse();
					if (dailyFiles.length > 0) sections.push(`Daily logs (${dailyFiles.length}):\n${dailyFiles.slice(0, 10).map(f => `- daily/${f}`).join("\n")}${dailyFiles.length > 10 ? `\n  ... and ${dailyFiles.length - 10} more` : ""}`);
				} catch {}
				if (sections.length === 0) {
					return { content: [{ type: "text", text: "Memory directory is empty." }], details: {} };
				}
				return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
			}

			if (target === "file") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'file'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(config.memoryDir, safe);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `File not found: ${safe}` }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: filePath, filename: safe } };
			}

			if (target === "note") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'note'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(config.notesDir, safe);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `Note not found: notes/${safe}` }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: filePath, filename: `notes/${safe}` } };
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				const filePath = dailyPath(config.dailyDir, d);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `No daily log for ${d}.` }], details: {} };
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: filePath, date: d },
				};
			}

			if (target === "scratchpad") {
				const content = readFileSafe(config.scratchpadFile);
				if (!content?.trim()) {
					return { content: [{ type: "text", text: "SCRATCHPAD.md is empty or does not exist." }], details: {} };
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: config.scratchpadFile },
				};
			}

			// long_term
			const content = readFileSafe(config.memoryFile);
			if (!content) {
				return { content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }], details: {} };
			}
			return {
				content: [{ type: "text", text: content }],
				details: { path: config.memoryFile },
			};
		},
	});

	// memory_search tool
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs, notes/, and any other .md files).",
			"Matches filenames and file contents. Case-insensitive keyword search.",
			"Returns matching files and lines with paths.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String({ description: "Search query (case-insensitive substring match)" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results to return (default: 20)", default: 20 }),
			),
		}),
		async execute(_toolCallId, params) {
			ensureDirs(config);
			const { query, max_results } = params;
			const limit = max_results ?? 20;

			const result = searchMemory(config, query, limit);

			if (result.fileMatches.length === 0 && result.lineResults.length === 0) {
				return { content: [{ type: "text", text: `No results for "${query}".` }], details: {} };
			}

			const parts: string[] = [];
			if (result.fileMatches.length > 0) {
				parts.push(`Files matching "${query}":\n${result.fileMatches.map(f => `- ${f}`).join("\n")}`);
			}
			if (result.lineResults.length > 0) {
				parts.push(`Content matches:\n${result.lineResults.map(r => `${r.file}:${r.line}: ${r.text}`).join("\n")}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { query, fileMatches: result.fileMatches.length, lineMatches: result.lineResults.length },
			};
		},
	});
}
