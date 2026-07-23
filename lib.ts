/**
 * Pure logic extracted from the memory extension for testability.
 * No pi API dependencies — just file I/O and string manipulation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// --- Config ---

export interface MemoryConfig {
	memoryDir: string;
	memoryFile: string;
	scratchpadFile: string;
	dailyDir: string;
	notesDir: string;
	contextFiles: string[];
	searchDirs: string[];
	autocommit: boolean;
	timezone: string;
}

export interface FileConfig {
	dailyDir?: string;
	contextFiles?: string[];
	searchDirs?: string[];
	autocommit?: boolean;
}

export function loadConfigFile(memoryDir: string): FileConfig {
	try {
		const raw = fs.readFileSync(path.join(memoryDir, ".pi-mem.json"), "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const result: FileConfig = {};
		if (typeof parsed.dailyDir === "string") result.dailyDir = parsed.dailyDir;
		if (Array.isArray(parsed.contextFiles)) result.contextFiles = parsed.contextFiles.filter((s: unknown) => typeof s === "string");
		if (Array.isArray(parsed.searchDirs)) result.searchDirs = parsed.searchDirs.filter((s: unknown) => typeof s === "string");
		if (typeof parsed.autocommit === "boolean") result.autocommit = parsed.autocommit;
		return result;
	} catch {
		return {};
	}
}

function parseCommaSeparated(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const items = value.split(",").map(f => f.trim()).filter(Boolean);
	return items;
}

export function resolveHomeDir(
	env: Record<string, string | undefined> = process.env,
	fallback = os.homedir(),
): string {
	fallback ??= os.homedir();
	return env.HOME
		?? env.USERPROFILE
		?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
		?? fallback;
}

export function resolveAgentDir(
	env: Record<string, string | undefined> = process.env,
	fallbackHome = os.homedir(),
): string {
	fallbackHome ??= os.homedir();
	return env.PI_CODING_AGENT_DIR ?? path.join(resolveHomeDir(env, fallbackHome), ".pi", "agent");
}

export function resolveSessionsDir(
	env: Record<string, string | undefined> = process.env,
	fallbackHome = os.homedir(),
): string {
	fallbackHome ??= os.homedir();
	return path.join(resolveAgentDir(env, fallbackHome), "sessions");
}

export function buildConfig(env: Record<string, string | undefined> = process.env): MemoryConfig {
	const memoryDir = env.PI_MEMORY_DIR ?? path.join(resolveAgentDir(env), "memory");

	// Load config.json from memory dir (env vars override file values)
	const fileConfig = loadConfigFile(memoryDir);

	const dailyDir = env.PI_DAILY_DIR ?? fileConfig.dailyDir ?? path.join(memoryDir, "daily");
	const contextFiles = parseCommaSeparated(env.PI_CONTEXT_FILES) ?? fileConfig.contextFiles ?? [];
	const searchDirs = parseCommaSeparated(env.PI_SEARCH_DIRS) ?? fileConfig.searchDirs ?? [];
	const autocommit = env.PI_AUTOCOMMIT !== undefined
		? (env.PI_AUTOCOMMIT === "1" || env.PI_AUTOCOMMIT === "true")
		: (fileConfig.autocommit ?? false);
	const timezone = normalizeTimeZone(env.PI_TIMEZONE ?? env.TZ ?? "UTC");

	return {
		memoryDir,
		memoryFile: path.join(memoryDir, "MEMORY.md"),
		scratchpadFile: path.join(memoryDir, "SCRATCHPAD.md"),
		dailyDir,
		notesDir: path.join(memoryDir, "notes"),
		contextFiles,
		searchDirs,
		autocommit,
		timezone,
	};
}

export function normalizeTimeZone(timeZone: string | undefined): string {
	const candidate = timeZone?.trim() || "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
		return candidate;
	} catch {
		return "UTC";
	}
}

// --- Date/time helpers ---

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: normalizeTimeZone(timeZone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
	return { year: values.year, month: values.month, day: values.day };
}

function formatDateParts(parts: { year: number; month: number; day: number }): string {
	return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function todayStr(timeZone = "UTC", now = new Date()): string {
	return formatDateParts(localDateParts(now, timeZone));
}

export function yesterdayStr(timeZone = "UTC", now = new Date()): string {
	return daysAgoStr(1, timeZone, now);
}

/** Get a date string N days ago from today. */
export function daysAgoStr(n: number, timeZone = "UTC", now = new Date()): string {
	const parts = localDateParts(now, timeZone);
	const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - n, 12, 0, 0, 0));
	return formatDateParts(localDateParts(shifted, timeZone));
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

/** Validate and normalize a relative file path within the memory directory. Returns null if path escapes memoryDir. */
export function safeResolvePath(memoryDir: string, filename: string): { resolved: string; normalized: string } | null {
	memoryDir = path.normalize(memoryDir);
	filename = path.normalize(filename);

	// Block absolute paths
	if (/^(\\|\/)/.test(filename) || (os.platform() === 'win32' && /^\w:(\/|\\)/.test(filename))) return null;
	
	// Join and resolve memoryDir and filename to get the full path to the file.
	const resolved = path.join(memoryDir, filename);


	// Block directory traversal: Return null when joining the normalized memoryDir and filename produces a path that
	// does not start with memoryDir.
	if (!resolved.startsWith(memoryDir)) return null;

	// Remove memoryDir from the resolved path and return it as normalized. Trim any leading slashes.
	const normalized = resolved.replace(memoryDir, '').replace(/^(\\|\/)/, '');

	return { resolved, normalized };
}

export interface IndexEntry {
	directory: string;
	filename: string;
	title: string;
	line: string;
}

export interface MemoryReadResult {
	text: string;
	details: Record<string, unknown>;
}

function normalizeLookupText(value: string): string {
	return value
		.toLowerCase()
		.replace(/\.md$/i, "")
		.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
		.replace(/[_-]+/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function titleFromIndexLine(line: string): string {
	const withoutFileComment = line.replace(/<!--\s*file:[^>]+-->/i, "").trim();
	const parts = withoutFileComment.split(/\s+—\s+/);
	const titlePart = parts[0] ?? withoutFileComment;
	return titlePart
		.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "")
		.replace(/^[^:]{1,32}:\s*/i, "")
		.trim();
}

export function parseIndexFile(directory: string, content: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const line of content.split("\n")) {
		const match = line.match(/<!--\s*file:([^>]+?)\s*-->/i);
		if (!match) continue;
		const filename = match[1].trim();
		if (!filename || filename.includes("/") || filename.includes("..")) continue;
		entries.push({ directory, filename, title: titleFromIndexLine(line), line: line.trim() });
	}
	return entries;
}

function scoreIndexEntry(entry: IndexEntry, query: string): number {
	const normalizedQuery = normalizeLookupText(query);
	if (!normalizedQuery) return 0;
	const normalizedTitle = normalizeLookupText(entry.title);
	const normalizedFilename = normalizeLookupText(entry.filename);
	const normalizedLine = normalizeLookupText(entry.line);
	const haystack = `${normalizedTitle} ${normalizedFilename} ${normalizedLine}`;
	if (normalizedTitle === normalizedQuery || normalizedFilename === normalizedQuery) return 100;
	if (normalizedTitle.includes(normalizedQuery) || normalizedFilename.includes(normalizedQuery)) return 80;
	const tokens = normalizedQuery.split(" ").filter(Boolean);
	if (tokens.length === 0) return 0;
	const hits = tokens.filter(token => haystack.includes(token)).length;
	if (hits === 0) return 0;
	return hits / tokens.length;
}

function formatIndexCandidates(directory: string, entries: IndexEntry[], heading: string): string {
	const lines = [heading, "", ...entries.map(e => `- ${directory}/${e.filename} — ${e.title || e.filename}`)];
	return lines.join("\n");
}

function listSiblingIndexedDirectories(config: MemoryConfig, directory: string): string[] {
	const parent = path.dirname(directory);
	try {
		const parentPath = path.join(config.memoryDir, parent);
		return fs.readdirSync(parentPath)
			.map(name => parent === "." ? name : `${parent}/${name}`)
			.filter(candidate => {
				try { return fs.statSync(path.join(config.memoryDir, candidate)).isDirectory(); } catch { return false; }
			})
			.filter(candidate => readFileSafe(path.join(config.memoryDir, candidate, "INDEX.md")))
			.sort()
			.reverse()
			.slice(0, 10);
	} catch {
		return [];
	}
}

export function resolveIndexedFile(config: MemoryConfig, directory: string, query: string): MemoryReadResult {
	const indexPath = path.join(config.memoryDir, directory, "INDEX.md");
	const indexContent = readFileSafe(indexPath);
	if (!indexContent) {
		const alternatives = listSiblingIndexedDirectories(config, directory);
		const suffix = alternatives.length > 0 ? ` Indexed directories nearby: ${alternatives.map(d => `${d}${path.sep}`).join(", ")}` : "";
		return { text: `No INDEX.md for ${directory}.${suffix}`, details: { directory, found: false, reason: "missing_index" } };
	}

	const entries = parseIndexFile(directory, indexContent);
	if (entries.length === 0) {
		return { text: `No indexed entries found in ${directory}${path.sep}INDEX.md.`, details: { directory, found: false, reason: "empty_index" } };
	}

	const scored = entries
		.map(entry => ({ entry, score: scoreIndexEntry(entry, query) }))
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.filename.localeCompare(b.entry.filename));

	if (scored.length === 0) {
		return {
			text: formatIndexCandidates(directory, entries, `No indexed entry matched "${query}" in ${directory}${path.sep}INDEX.md. Candidates:`),
			details: { directory, query, found: false, reason: "no_match", candidates: entries.map(e => e.filename) },
		};
	}

	const topScore = scored[0].score;
	const top = scored.filter(item => item.score === topScore).map(item => item.entry);
	const queryTokens = normalizeLookupText(query).split(" ").filter(Boolean);
	if (top.length > 1 || (queryTokens.length === 1 && scored.length > 1 && topScore < 100)) {
		const candidates = scored.slice(0, 10).map(item => item.entry);
		return {
			text: formatIndexCandidates(directory, candidates, `Multiple indexed entries matched "${query}". Use one of these exact paths:`),
			details: { directory, query, found: false, reason: "ambiguous", candidates: candidates.map(e => e.filename) },
		};
	}

	const match = scored[0].entry;
	const filePath = path.join(config.memoryDir, directory, match.filename);
	const content = readFileSafe(filePath);
	if (!content) {
		return {
			text: `INDEX.md points to missing file: ${directory}${path.sep}${match.filename}`,
			details: { directory, query, found: false, reason: "missing_resolved_file", filename: match.filename, path: filePath },
		};
	}
	return { text: content, details: { path: filePath, filename: path.join(directory, match.filename), resolvedFrom: query, title: match.title } };
}

export function readMemoryFile(config: MemoryConfig, filename: string): MemoryReadResult {
	const result = safeResolvePath(config.memoryDir, filename);
	if (!result) {
		return { text: `Invalid path: ${filename}`, details: { found: false, reason: "invalid_path" } };
	}
	const content = readFileSafe(result.resolved);
	if (content) {
		return { text: content, details: { path: result.resolved, filename: result.normalized } };
	}

	const directory = path.dirname(result.normalized);
	const basename = path.basename(result.normalized).replace(/\.md$/i, "");
	if (directory && directory !== "." && basename !== "INDEX") {
		return resolveIndexedFile(config, directory, basename);
	}

	return { text: `File not found: ${result.normalized}`, details: { found: false, reason: "missing_file", filename: result.normalized } };
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

// --- Activity detection ---

/** Minimum bytes in a daily log to count as "active" for that day. */
const ACTIVITY_THRESHOLD_BYTES = 50;

/** Number of trailing days to check for activity. */
const ACTIVITY_LOOKBACK_DAYS = 3;

/** Threshold: if fewer than this many of the lookback days have activity, user is "low activity". */
const ACTIVITY_MIN_ACTIVE_DAYS = 1;

/** Max catchup days to inject when in rollup mode. */
const ROLLUP_CATCHUP_DAYS = 7;

/** Normal catchup days (today + yesterday). */
const NORMAL_CATCHUP_DAYS = 2;

/**
 * Detect low user activity by checking daily log sizes for the trailing N days.
 * Returns true if the user has been inactive (daily logs mostly empty/missing).
 */
export function isLowActivity(config: MemoryConfig): boolean {
	let activeDays = 0;
	for (let i = 0; i < ACTIVITY_LOOKBACK_DAYS; i++) {
		const date = daysAgoStr(i, config.timezone);
		const content = readFileSafe(dailyPath(config.dailyDir, date));
		if (content && content.trim().length >= ACTIVITY_THRESHOLD_BYTES) {
			activeDays++;
		}
	}
	return activeDays <= ACTIVITY_MIN_ACTIVE_DAYS;
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

	const today = todayStr(config.timezone);
	const yesterday = yesterdayStr(config.timezone);

	const todayContent = readFileSafe(dailyPath(config.dailyDir, today));
	if (todayContent?.trim()) {
		sections.push(`## Daily log: ${today} (today)\n\n${todayContent.trim()}`);
	}

	const yesterdayContent = readFileSafe(dailyPath(config.dailyDir, yesterday));
	if (yesterdayContent?.trim()) {
		sections.push(`## Daily log: ${yesterday} (yesterday)\n\n${yesterdayContent.trim()}`);
	}

	// Auto-inject catchup INDEX.md — expand window when user has been inactive
	const catchupDir = path.join(config.memoryDir, "catchup");
	const lowActivity = isLowActivity(config);
	const catchupDays = lowActivity ? ROLLUP_CATCHUP_DAYS : NORMAL_CATCHUP_DAYS;

	// In rollup mode, use a smaller per-day cap to fit more days
	const MAX_CATCHUP_BYTES_PER_DAY = lowActivity ? 1024 : 2048;
	// Total catchup budget to prevent system prompt bloat
	const MAX_CATCHUP_TOTAL_BYTES = 8192;
	let catchupTotalBytes = 0;

	// Collect catchup sections first, then prepend rollup header if any exist
	const catchupSections: string[] = [];

	for (let i = 0; i < catchupDays; i++) {
		if (catchupTotalBytes >= MAX_CATCHUP_TOTAL_BYTES) break;
		const date = daysAgoStr(i, config.timezone);
		const label = i === 0 ? "today" : i === 1 ? "yesterday" : `${i} days ago`;
		const indexPath = path.join(catchupDir, date, "INDEX.md");
		let catchupContent = readFileSafe(indexPath)?.trim();
		if (catchupContent) {
			if (catchupContent.length > MAX_CATCHUP_BYTES_PER_DAY) {
				const lines = catchupContent.split("\n");
				let truncated = "";
				let kept = 0;
				for (const line of lines) {
					if (truncated.length + line.length + 1 > MAX_CATCHUP_BYTES_PER_DAY) break;
					truncated += (kept > 0 ? "\n" : "") + line;
					kept++;
				}
				const remaining = lines.length - kept;
				if (remaining > 0) {
					truncated += `\n... (${remaining} more entries — use memory_read(target='file', filename='catchup/${date}/INDEX.md') to see all)`;
				}
				catchupContent = truncated;
			}
			const header = `## Catchup: ${date} (${label})`;
			const hint = `_Read full details: memory_read(target='file', filename='catchup/${date}/FILENAME.md')_`;
			catchupSections.push(`${header}\n${hint}\n\n${catchupContent}`);
			catchupTotalBytes += catchupContent.length;
		}
	}

	// Only inject rollup mode header if there's actually catchup data to show
	if (lowActivity && catchupSections.length > 0) {
		sections.push(
			"## \u26a1 Rollup Mode\n" +
			`_Low activity detected over the last ${ACTIVITY_LOOKBACK_DAYS} days. ` +
			`Catchup window expanded from ${NORMAL_CATCHUP_DAYS} to ${catchupDays} days._`
		);
	}

	for (const s of catchupSections) {
		sections.push(s);
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

	// Search extra dirs configured via PI_SEARCH_DIRS
	for (const dirName of config.searchDirs) {
		if (lineResults.length >= maxResults) break;
		const dirPath = path.join(config.memoryDir, dirName);
		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			// Search .md files directly in the dir
			const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md"));
			for (const f of mdFiles) {
				if (lineResults.length >= maxResults) break;
				searchFile(path.join(dirPath, f.name), `${dirName}/${f.name}`);
			}
			// Search one level of subdirectories (e.g. catchup/2026-04-20/*.md)
			const subDirs = entries.filter(e => e.isDirectory());
			for (const sub of subDirs) {
				if (lineResults.length >= maxResults) break;
				searchDir(path.join(dirPath, sub.name), `${dirName}/${sub.name}`);
			}
		} catch {}
	}

	return { fileMatches, lineResults };
}
