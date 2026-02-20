/**
 * Pure logic extracted from the memory extension for testability.
 * No pi API dependencies — just file I/O and string manipulation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// --- Config ---

export interface MemoryConfig {
	memoryDir: string;
	memoryFile: string;
	scratchpadFile: string;
	dailyDir: string;
	notesDir: string;
	sessionDir: string;
	contextFiles: string[];
	autocommit: boolean;
}

export function buildConfig(env: Record<string, string | undefined> = process.env): MemoryConfig {
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(env.HOME ?? "~", ".pi", "agent");
	const memoryDir = env.PI_MEMORY_DIR ?? path.join(agentDir, "memory");
	const dailyDir = env.PI_DAILY_DIR ?? path.join(memoryDir, "daily");
	const contextFiles = (env.PI_CONTEXT_FILES ?? "")
		.split(",")
		.map(f => f.trim())
		.filter(Boolean);
	const autocommit = env.PI_AUTOCOMMIT === "1" || env.PI_AUTOCOMMIT === "true";

	return {
		memoryDir,
		memoryFile: path.join(memoryDir, "MEMORY.md"),
		scratchpadFile: path.join(memoryDir, "SCRATCHPAD.md"),
		dailyDir,
		notesDir: path.join(memoryDir, "notes"),
		sessionDir: path.join(agentDir, "sessions"),
		contextFiles,
		autocommit,
	};
}

// --- Date/time helpers ---

export function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

export function nowTimestamp(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

// --- File helpers ---

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

export function dailyPath(dailyDir: string, date: string): string {
	return path.join(dailyDir, `${date}.md`);
}

export function ensureDirs(config: MemoryConfig): void {
	fs.mkdirSync(config.memoryDir, { recursive: true });
	fs.mkdirSync(config.dailyDir, { recursive: true });
	fs.mkdirSync(config.notesDir, { recursive: true });
}

// --- Scratchpad ---

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string;
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return lines.join("\n") + "\n";
}

// --- Memory context builder ---

export function buildMemoryContext(config: MemoryConfig): string {
	ensureDirs(config);
	const sections: string[] = [];

	for (const fileName of config.contextFiles) {
		const filePath = path.join(config.memoryDir, fileName);
		const content = readFileSafe(filePath);
		if (content?.trim()) {
			sections.push(`## ${fileName}\n\n${content.trim()}`);
		}
	}

	const longTerm = readFileSafe(config.memoryFile);
	if (longTerm?.trim()) {
		sections.push(`## MEMORY.md (long-term)\n\n${longTerm.trim()}`);
	}

	const scratchpad = readFileSafe(config.scratchpadFile);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			sections.push(`## SCRATCHPAD.md (working context)\n\n${serializeScratchpad(openItems)}`);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(config.dailyDir, today));
	if (todayContent?.trim()) {
		sections.push(`## Daily log: ${today} (today)\n\n${todayContent.trim()}`);
	}

	const yesterdayContent = readFileSafe(dailyPath(config.dailyDir, yesterday));
	if (yesterdayContent?.trim()) {
		sections.push(`## Daily log: ${yesterday} (yesterday)\n\n${yesterdayContent.trim()}`);
	}

	if (sections.length === 0) {
		return "";
	}

	return `# Memory\n\n${sections.join("\n\n---\n\n")}`;
}

// --- Session scanner ---

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface SessionInfo {
	file: string;
	timestamp: string;
	title: string;
	isChild: boolean;
	parentSession?: string;
	cwd: string;
	cost: number;
}

export async function scanSession(filePath: string): Promise<SessionInfo | null> {
	try {
		const cutoffTime = Date.now() - LOOKBACK_MS;
		const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
		let lineNum = 0;
		let header: any = null;
		let title = "";
		let totalCost = 0;

		for await (const line of rl) {
			lineNum++;
			if (lineNum === 1) {
				try {
					header = JSON.parse(line);
				} catch { return null; }
				if (header.timestamp && new Date(header.timestamp).getTime() < cutoffTime) {
					rl.close();
					return null;
				}
				continue;
			}
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info" && entry.name) {
					title = entry.name;
				}
				if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage?.cost?.total) {
					totalCost += entry.message.usage.cost.total;
				}
			} catch { continue; }
		}

		if (!header?.timestamp) return null;

		if (!title) {
			const rl2 = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
			for await (const line of rl2) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message?.role === "user") {
						const content = entry.message.content;
						if (typeof content === "string") {
							title = content.slice(0, 80);
						} else if (Array.isArray(content)) {
							const textPart = content.find((c: any) => c.type === "text");
							if (textPart) title = textPart.text.slice(0, 80);
						}
						break;
					}
				} catch { continue; }
			}
		}

		return {
			file: filePath,
			timestamp: header.timestamp,
			title: title || "(untitled)",
			isChild: !!header.parentSession,
			parentSession: header.parentSession || undefined,
			cwd: header.cwd || "",
			cost: totalCost,
		};
	} catch { return null; }
}

export function isHousekeeping(title: string): boolean {
	const lower = title.toLowerCase();
	const patterns = [
		/^(clear|review|read)\s+(done|scratchpad|today|daily)/,
		/^-\s+(no done|scratchpad|cleared|reviewed|task is)/,
		/^scratchpad\s+(content|management|maintenance|reviewed|items)/,
		/^\(untitled\)$/,
		/^\/\w+$/,
		/^write daily log/,
	];
	return patterns.some(p => p.test(lower));
}

// --- Search ---

export interface SearchResult {
	fileMatches: string[];
	lineResults: { file: string; line: number; text: string }[];
}

export function searchMemory(config: MemoryConfig, query: string, maxResults: number = 20): SearchResult {
	const needle = query.toLowerCase();
	const fileMatches: string[] = [];
	const lineResults: { file: string; line: number; text: string }[] = [];

	function searchFile(filePath: string, displayName: string) {
		if (displayName.toLowerCase().includes(needle) && !fileMatches.includes(displayName)) {
			fileMatches.push(displayName);
		}
		const content = readFileSafe(filePath);
		if (!content) return;
		const lines = content.split("\n");
		for (let i = 0; i < lines.length && lineResults.length < maxResults; i++) {
			if (lines[i].toLowerCase().includes(needle)) {
				lineResults.push({ file: displayName, line: i + 1, text: lines[i].trimEnd() });
			}
		}
	}

	function searchDir(dir: string, prefix: string) {
		try {
			const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();
			for (const f of files) {
				if (lineResults.length >= maxResults) break;
				searchFile(path.join(dir, f), prefix ? `${prefix}/${f}` : f);
			}
		} catch {}
	}

	searchDir(config.memoryDir, "");
	searchDir(config.dailyDir, "daily");
	searchDir(config.notesDir, "notes");

	return { fileMatches, lineResults };
}
