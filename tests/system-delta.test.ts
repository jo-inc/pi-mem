import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanup, makeConfig } from "./helpers.ts";
import {
	DELTA_EMPTY_DAILY,
	DELTA_MAX_CHARS,
	DELTA_MESSAGE_TYPE,
	DELTA_DETAILS_VERSION,
	writeFileAtomic,
	condenseDailyLogs,
	condenseMemoryBody,
	CONTEXT_FILES_INTRO,
	formatPinnedContext,
	readContextFiles,
	diffTracked,
	entryHash,
	formatChangeSection,
	renderSections,
	planDelta,
	rebuildDeltaState,
	splitEntries,
	trackState,
	todayStr,
	yesterdayStr,
	dailyPath,
} from "../lib.ts";

const entry = (ts: string, sid: string, text: string) => `<!-- ${ts} [${sid}] -->\n${text}`;
const NONE = new Set<string>();

describe("splitEntries", () => {
	it("splits on header lines and keeps text before the first header as its own block", () => {
		const text = `# Memory\n- old fact\n\n${entry("2026-11-19 09:00:00", "aaaa1111", "one")}\n\n${entry("2026-11-19 10:00:00", "bbbb2222", "two\nmore")}`;
		const parts = splitEntries(text);
		assert.deepStrictEqual(parts, [
			"# Memory\n- old fact",
			entry("2026-11-19 09:00:00", "aaaa1111", "one"),
			entry("2026-11-19 10:00:00", "bbbb2222", "two\nmore"),
		]);
	});
});

describe("diffTracked", () => {
	const base = entry("2026-11-19 09:00:00", "01a1ef4c", "Base entry.");
	const other = entry("2026-11-19 10:00:00", "01a1ef4c", "Entry from a concurrent session.");
	const mine = entry("2026-11-19 10:01:00", "01a1ef4c", "Entry this session wrote.");

	it("reports unchanged, missing and new files", () => {
		assert.deepStrictEqual(diffTracked(trackState(base), base, NONE), { kind: "unchanged" });
		assert.deepStrictEqual(diffTracked(undefined, null, NONE), { kind: "unchanged" });
		assert.deepStrictEqual(diffTracked(trackState(base), null, NONE), { kind: "removed" });
		assert.deepStrictEqual(diffTracked(undefined, base, NONE), { kind: "appended", text: base });
	});

	it("returns only the appended entries", () => {
		const change = diffTracked(trackState(base), `${base}\n\n${other}`, NONE);
		assert.deepStrictEqual(change, { kind: "appended", text: other });
	});

	it("strips this session's own entries by hash, even when the short session id is shared", () => {
		const own = new Set([entryHash(mine)]);
		const change = diffTracked(trackState(base), `${base}\n\n${other}\n\n${mine}`, own);
		assert.deepStrictEqual(change, { kind: "appended", text: other }, "same [sid], different entry: kept");
		const onlyMine = diffTracked(trackState(base), `${base}\n\n${mine}`, own);
		assert.deepStrictEqual(onlyMine, { kind: "appended", text: "" });
	});

	it("treats text that continues the last line as an edit, not an append", () => {
		const change = diffTracked(trackState("# M\n- a"), "# M\n- a (fixed)", NONE);
		assert.deepStrictEqual(change, { kind: "revised", addedLines: ["- a (fixed)"], removedCount: 1, reorderedLines: [] });
	});

	it("reports reordered lines instead of nothing (regression)", () => {
		const change = diffTracked(trackState("a\nb\nc"), "c\na\nb", NONE);
		assert.deepStrictEqual(change, { kind: "revised", addedLines: [], removedCount: 0, reorderedLines: ["c", "a", "b"] });
		const section = formatChangeSection("MEMORY.md", change, "memory_read(target='long_term')");
		assert.ok(section?.body.endsWith("Reordered lines in current file order (earlier to later):\nc\na\nb"));
	});

	it("reports a reorder beyond the old LCS limit", () => {
		const lines = Array.from({ length: 2001 }, (_, i) => `Line ${i}`);
		const baseline = trackState(lines.join("\n"));
		const after = [...lines.slice(0, -2), lines[2000], lines[1999]];
		const section = formatChangeSection("MEMORY.md", diffTracked(baseline, after.join("\n"), NONE), "memory_read");
		assert.ok(section?.heading.includes("line order changed"));
		assert.ok(section?.body.endsWith("Line 2000\nLine 1999"));
	});

	it("reports changed precedence when a repeated line moves", () => {
		const before = "active\ninactive\nactive";
		const after = "active\nactive\ninactive";
		const section = formatChangeSection("MEMORY.md", diffTracked(trackState(before), after, NONE), "memory_read");
		assert.ok(section?.heading.includes("line order changed"));
		assert.ok(section?.body.endsWith("active\ninactive"));
	});

	it("reports a whitespace-only edit with a read hint (regression)", () => {
		const change = diffTracked(trackState("a\nb"), "a \nb", NONE);
		assert.strictEqual(change.kind, "revised");
		const section = formatChangeSection("MEMORY.md", change, "memory_read(target='long_term')");
		assert.ok(section?.body.includes("memory_read(target='long_term')"));
	});

	it("reports an edit that is not an append as new lines plus a count of removed lines", () => {
		const prev = "line one\nline two\nline three";
		const change = diffTracked(trackState(prev), "line one\nline 2 (fixed)\nline three\nline four", NONE);
		assert.deepStrictEqual(change, { kind: "revised", addedLines: ["line 2 (fixed)", "line four"], removedCount: 1, reorderedLines: [] });
	});
});

describe("planDelta", () => {
	const dates = { today: "2026-11-19", yesterday: "2026-11-18" };
	const y = entry("2026-11-18 12:00:00", "aaaa1111", "Yesterday work.");
	const t = entry("2026-11-19 08:00:00", "bbbb2222", "Today work.");

	it("sends a snapshot of both days when the branch has no baseline", () => {
		const plan = planDelta({ baseline: null, pinnedMemory: "# M", memory: "# M", dates, logs: { [dates.today]: t, [dates.yesterday]: y }, own: NONE });
		assert.strictEqual(plan.kind, "snapshot");
		assert.ok(plan.content.includes("Today work.") && plan.content.includes("Yesterday work."));
		assert.ok(!plan.content.includes("MEMORY.md"), "pinned memory unchanged: no MEMORY.md section");
		assert.deepStrictEqual(Object.keys(plan.baseline.daily).sort(), [dates.yesterday, dates.today]);
	});

	it("still sends a snapshot when there are no daily logs, so the pin is saved", () => {
		const plan = planDelta({ baseline: null, pinnedMemory: "", memory: null, dates, logs: {}, own: NONE });
		assert.strictEqual(plan.kind, "snapshot");
		assert.ok(plan.content.includes(DELTA_EMPTY_DAILY));
	});

	it("keeps the snapshot within the character limit, newest entries first", () => {
		const big = Array.from({ length: 300 }, (_, i) => entry("2026-11-19 08:00:00", "bbbb2222", `Entry number ${i}.`)).join("\n\n");
		const plan = planDelta({ baseline: null, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: big, [dates.yesterday]: big }, own: NONE });
		assert.ok(plan.content.length <= DELTA_MAX_CHARS, `snapshot is ${plan.content.length} chars`);
		assert.ok(plan.content.includes("Entry number 299."), "latest entry kept");
		assert.ok(plan.content.includes("memory_read"), "points to the full log");
	});

	it("sends nothing when nothing changed, and a diff when another session appended", () => {
		const first = planDelta({ baseline: null, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: t }, own: NONE });
		const same = planDelta({ baseline: first.baseline, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: t }, own: NONE });
		assert.strictEqual(same.kind, "none");
		const added = entry("2026-11-19 09:00:00", "cccc3333", "Other session note.");
		const update = planDelta({ baseline: first.baseline, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: `${t}\n\n${added}` }, own: NONE });
		assert.strictEqual(update.kind, "update");
		assert.ok(update.content.includes("## Daily log 2026-11-19: new entries\n" + added));
		assert.ok(!update.content.includes("Today work."), "old entries are not sent again");
	});

	it("keys the baseline by date across a midnight rollover", () => {
		const before = planDelta({ baseline: null, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: t, [dates.yesterday]: y }, own: NONE });
		const next = { today: "2026-11-20", yesterday: "2026-11-19" };
		const n = entry("2026-11-20 00:05:00", "dddd4444", "After midnight.");
		const plan = planDelta({ baseline: before.baseline, pinnedMemory: "", memory: "", dates: next, logs: { [next.today]: n, [next.yesterday]: t }, own: NONE });
		assert.strictEqual(plan.kind, "update");
		assert.ok(plan.content.includes("## Daily log 2026-11-20: new entries\n" + n));
		assert.ok(!plan.content.includes("2026-11-19:"), "yesterday unchanged: no section");
		assert.ok(!plan.content.includes("removed"), "the day that left the window is dropped quietly");
		assert.deepStrictEqual(Object.keys(plan.baseline.daily).sort(), ["2026-11-19", "2026-11-20"]);
	});

	it("sends MEMORY.md changes as a diff and does not resend them", () => {
		const first = planDelta({ baseline: null, pinnedMemory: "# M\n- a", memory: "# M\n- a", dates, logs: {}, own: NONE });
		const fact = entry("2026-11-19 11:00:00", "eeee5555", "- New durable fact.");
		const memory = `# M\n- a\n\n${fact}`;
		const update = planDelta({ baseline: first.baseline, pinnedMemory: "# M\n- a", memory, dates, logs: {}, own: NONE });
		assert.ok(update.content.includes("## MEMORY.md: new entries\n" + fact));
		const again = planDelta({ baseline: update.baseline, pinnedMemory: "# M\n- a", memory, dates, logs: {}, own: NONE });
		assert.strictEqual(again.kind, "none");
	});

	it("after compaction, the snapshot carries MEMORY.md changes since the pin", () => {
		const appended = planDelta({ baseline: null, pinnedMemory: "# M\n- a", memory: "# M\n- a\n- b", dates, logs: { [dates.today]: t }, own: NONE });
		assert.strictEqual(appended.kind, "snapshot");
		assert.ok(appended.content.includes("## MEMORY.md: new entries\n- b"));
		const edited = planDelta({ baseline: null, pinnedMemory: "# M\n- a", memory: "# M\n- a (fixed)", dates, logs: {}, own: NONE });
		assert.ok(edited.content.includes("## MEMORY.md: edited, not only appended\nNew or changed lines:\n- a (fixed)\n(1 earlier line was removed or changed."));
	});

	it("keeps this session's own MEMORY.md entries in a snapshot, but strips them from an update", () => {
		const mine = entry("2026-11-19 11:00:00", "01a1ef4c", "- My own fact.");
		const own = new Set([entryHash(mine)]);
		const memory = `# M\n\n${mine}`;
		const snap = planDelta({ baseline: null, pinnedMemory: "# M", memory, dates, logs: {}, own });
		assert.ok(snap.content.includes("My own fact."), "snapshot after compaction keeps it");
		const first = planDelta({ baseline: null, pinnedMemory: "# M", memory: "# M", dates, logs: {}, own: NONE });
		const update = planDelta({ baseline: first.baseline, pinnedMemory: "# M", memory, dates, logs: {}, own });
		assert.strictEqual(update.kind, "none", "update strips it");
	});

	it("caps a large diff at the limit and keeps the newest changes", () => {
		const first = planDelta({ baseline: null, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: t }, own: NONE });
		const flood = Array.from({ length: 200 }, (_, i) => entry("2026-11-19 12:00:00", "ffff6666", `Flood ${i}.`)).join("\n\n");
		const plan = planDelta({ baseline: first.baseline, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: `${t}\n\n${flood}` }, own: NONE });
		assert.ok(plan.content.length <= DELTA_MAX_CHARS, `diff is ${plan.content.length} chars`);
		assert.ok(plan.content.includes("Flood 199.") && plan.content.includes("earlier changes omitted"));
	});

	it("sends an update when MEMORY.md lines only change order (regression)", () => {
		const pinnedMemory = "- Status: active\n- Status: inactive";
		const memory = "- Status: inactive\n- Status: active";
		const first = planDelta({ baseline: null, pinnedMemory, memory: pinnedMemory, dates, logs: {}, own: NONE });
		const plan = planDelta({ baseline: first.baseline, pinnedMemory, memory, dates, logs: {}, own: NONE });
		assert.strictEqual(plan.kind, "update");
		assert.ok(plan.content.includes("## MEMORY.md: edited, not only appended"));
		assert.ok(plan.content.includes("current file order (earlier to later):\n" + memory));
	});

	it("keeps every section heading when a large update is clipped (regression)", () => {
		const first = planDelta({ baseline: null, pinnedMemory: "# M", memory: "# M", dates, logs: { [dates.today]: t }, own: NONE });
		const flood = Array.from({ length: 300 }, (_, i) => entry("2026-11-19 12:00:00", "ffff6666", `Flood ${i}.`)).join("\n\n");
		const fact = entry("2026-11-19 12:30:00", "eeee5555", "- New fact.");
		const plan = planDelta({ baseline: first.baseline, pinnedMemory: "# M", memory: `# M\n\n${fact}`, dates, logs: { [dates.today]: `${t}\n\n${flood}` }, own: NONE });
		assert.ok(plan.content.length <= DELTA_MAX_CHARS, `diff is ${plan.content.length} chars`);
		assert.ok(plan.content.includes("## Daily log 2026-11-19: new entries\n… (earlier changes omitted"), "daily heading kept above the clipped body");
		assert.ok(plan.content.includes("Flood 299."), "newest entry kept");
		assert.ok(plan.content.includes("## MEMORY.md: new entries\n" + fact), "later section kept whole");
	});

	it("keeps the heading when one section alone is too long (regression)", () => {
		const out = renderSections([{ heading: "## Daily log 2026-11-19: new entries", body: "x\n".repeat(2000) + "last" }], 300, "… (cut)");
		assert.ok(out.length <= 300, `rendered ${out.length} chars`);
		assert.ok(out.startsWith("## Daily log 2026-11-19: new entries\n… (cut)\n"));
		assert.ok(out.endsWith("last"));
	});

	it("keeps both headings with a budget shorter than the full clip notice", () => {
		const headings = ["## Yesterday", "## Today"];
		const sections = headings.map(heading => ({ heading, body: "x".repeat(100) + "late" }));
		const budget = headings.join("\n\n").length + 6;
		const out = renderSections(sections, budget, "… (earlier changes omitted)");
		assert.ok(out.length <= budget);
		assert.ok(out.startsWith("## Yesterday\n…"));
		assert.ok(out.includes("\n\n## Today\n…"));
		assert.ok(out.endsWith("e"));
		assert.strictEqual(renderSections(sections, "## Today".length, "… (cut)"), "## Today");
	});

	it("keeps both daily headings and the tail of an oversized final line", () => {
		const logs = { [dates.today]: "😺".repeat(100) + " latest", [dates.yesterday]: "Older note." };
		const daily = condenseDailyLogs(dates, logs, 80);
		assert.ok(daily.length <= 80);
		assert.ok(daily.includes("## Daily log 2026-11-19\n…"));
		assert.ok(daily.includes("latest\n\n## Daily log 2026-11-18\n"));
		assert.strictEqual(daily.toWellFormed(), daily);

		const snapshot = planDelta({ baseline: null, pinnedMemory: "", memory: null, dates, logs: { ...logs, [dates.today]: "x".repeat(4200) + " latest" }, own: NONE });
		assert.ok(snapshot.content.length <= DELTA_MAX_CHARS);
		assert.ok(snapshot.content.includes("latest\n\n## Daily log 2026-11-18\nOlder note."));
	});

	it("flags an edit that is not an append so the caller can read again", () => {
		const first = planDelta({ baseline: null, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: t }, own: NONE });
		const plan = planDelta({ baseline: first.baseline, pinnedMemory: "", memory: "", dates, logs: { [dates.today]: t.slice(0, 10) }, own: NONE });
		assert.strictEqual(plan.revised, true);
	});
});

describe("rebuildDeltaState", () => {
	const baseline = { daily: { "2026-11-19": trackState("x") }, memory: trackState("# M") };
	const msg = (details: unknown) => ({ type: "custom_message", customType: DELTA_MESSAGE_TYPE, content: "", display: false, details });

	it("restores baseline, pin and own entries from the branch", () => {
		const state = rebuildDeltaState([
			msg({ v: DELTA_DETAILS_VERSION, kind: "snapshot", baseline, pinnedMemory: "# M" }),
			{ type: "message", message: { role: "toolResult", toolName: "memory_write", details: { ownEntryHash: "abc" } } },
			{ type: "message", message: { role: "toolResult", toolName: "memory_write", details: { ownMemoryState: trackState("new") } } },
		]);
		assert.strictEqual(state.pinnedMemory, "# M");
		assert.deepStrictEqual(state.baseline?.daily, baseline.daily);
		assert.deepStrictEqual(state.baseline?.memory, trackState("new"), "own overwrite moves the MEMORY.md baseline");
		assert.ok(state.own.has("abc"));
	});

	it("clears the baseline at a compaction but keeps the pin", () => {
		const state = rebuildDeltaState([
			msg({ v: DELTA_DETAILS_VERSION, kind: "snapshot", baseline, pinnedMemory: "# M" }),
			{ type: "compaction", summary: "s", firstKeptEntryId: "x" },
		]);
		assert.strictEqual(state.baseline, null);
		assert.strictEqual(state.pinnedMemory, "# M");
	});

	it("ignores other message types and unknown detail versions", () => {
		const state = rebuildDeltaState([
			msg({ v: 99, kind: "snapshot", baseline, pinnedMemory: "# M" }),
			{ type: "custom_message", customType: "other", details: { v: DELTA_DETAILS_VERSION, baseline } },
		]);
		assert.strictEqual(state.baseline, null);
		assert.strictEqual(state.pinnedMemory, null);
	});
});

// --- Handler flow, end to end against a fake pi ---

describe("system-delta handlers", () => {
	let tmp: string;
	let me: string;
	let saved: NodeJS.ProcessEnv;
	const entries: any[] = [];
	const SESSION_ID = "01a1ef4c-30aa-717b-8ffe-64244f09759a";
	const ctx: any = {
		hasUI: false,
		modelRegistry: null,
		ui: { setWidget: () => {}, notify: () => {} },
		sessionManager: { getBranch: () => entries, getSessionId: () => SESSION_ID },
	};

	async function load() {
		const handlers: Record<string, Function[]> = {};
		const tools: Record<string, any> = {};
		const sent: Array<{ message: any; options: any }> = [];
		const fakePi: any = {
			on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
			registerTool: (t: any) => { tools[t.name] = t; },
			registerCommand: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {},
			registerFlag: () => {}, getFlag: () => undefined, sendMessage: (message: any, options: any) => { sent.push({ message, options }); }, sendUserMessage: () => {}, setStatus: () => {},
		};
		const mod = await import(`../index.ts?delta=${Date.now()}-${Math.random()}`);
		mod.default(fakePi);
		const fire = async (name: string, event: any = {}) => {
			let result: any;
			for (const h of handlers[name] ?? []) result = await h(event, ctx);
			return result;
		};
		return { handlers, tools, fire, sent };
	}

	/** `save: false` acts as if Pi did not save the returned message (rejected or aborted). */
	async function agentStart(fire: Function, save = true) {
		const event: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: {} };
		const result = await fire("before_agent_start", event);
		if (save && result?.message) entries.push({ type: "custom_message", ...result.message });
		return { result, section: event.systemPromptOptions.sections.pi_mem_memory as string };
	}

	async function turnEnd(fire: Function, toolResults: unknown[] = [{}], save = true) {
		const result = await fire("turn_end", { type: "turn_end", outcome: "completed", toolResults, entries: [] });
		if (save) for (const e of result?.entries ?? []) entries.push(e);
		return result;
	}

	const today = () => todayStr("UTC");
	const todayFile = () => dailyPath(path.join(me, "daily"), today());

	before(() => {
		saved = { ...process.env };
		for (const k of Object.keys(process.env)) if (k.startsWith("PI_")) delete process.env[k];
		tmp = makeTempDir();
		me = path.join(tmp, "memory");
		fs.mkdirSync(path.join(me, "daily"), { recursive: true });
		fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Works at Northwind Labs.");
		fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system-delta", autocommit: false }));
		fs.writeFileSync(todayFile(), entry(`${today()} 08:00:00`, "aaaa1111", "Morning work."));
		fs.writeFileSync(dailyPath(path.join(me, "daily"), yesterdayStr("UTC")), entry(`${yesterdayStr("UTC")} 18:00:00`, "aaaa1111", "Evening work."));
		process.env.PI_MEMORY_DIR = me;
		process.env.PI_TIMEZONE = "UTC";
		process.env.PI_MEMORY_RECALL = "0";
	});

	after(() => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		delete (globalThis as any).__piMemSystemSection;
		cleanup(tmp);
	});

	it("runs the full session lifecycle without unsaved per-call injection", async () => {
		const { tools, fire } = await load();
		await fire("session_start", { reason: "startup" });
		try {
			// 1. Session start: pinned MEMORY.md in the section, daily logs as one saved snapshot.
			const start = await agentStart(fire);
			assert.ok(start.section.includes("Northwind Labs"));
			assert.strictEqual(start.result.message.customType, DELTA_MESSAGE_TYPE);
			assert.strictEqual(start.result.message.details.kind, "snapshot");
			assert.ok(start.result.message.content.includes("Morning work.") && start.result.message.content.includes("Evening work."));
			assert.strictEqual(start.result.message.details.pinnedMemory, "# Long-term memory\n- Works at Northwind Labs.");

			// 2. The context hook adds nothing.
			const ctxResult = await fire("context", { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			assert.strictEqual(ctxResult, undefined);

			// 3. Nothing changed: no message, same section.
			const quiet = await agentStart(fire);
			assert.strictEqual(quiet.result, undefined);
			assert.strictEqual(quiet.section, start.section);

			// 4. A concurrent session with the same short sid appends: diff between tool calls.
			const other = entry(`${today()} 09:00:00`, SESSION_ID.slice(0, 8), "Concurrent session note.");
			fs.appendFileSync(todayFile(), `\n\n${other}`);
			const diff = await turnEnd(fire);
			assert.ok(diff.entries[0].content.includes(other), "other session's entry delivered");
			assert.strictEqual(diff.entries[0].details.kind, "update");

			// 5. This session's own memory_write is not echoed back.
			const res = await tools.memory_write.execute("call-1", { target: "daily", content: "My own note." }, undefined, undefined, ctx);
			entries.push({ type: "message", message: { role: "toolResult", toolName: "memory_write", details: res.details } });
			assert.ok(fs.readFileSync(todayFile(), "utf-8").endsWith("My own note."), "appended at the end");
			assert.strictEqual(await turnEnd(fire), undefined, "own entry stripped");

			// 6. A turn without tool calls never adds an entry.
			fs.appendFileSync(todayFile(), `\n\n${entry(`${today()} 09:30:00`, "cccc3333", "Late note.")}`);
			assert.strictEqual(await turnEnd(fire, []), undefined);

			// 7. MEMORY.md changes elsewhere: section stays pinned, change arrives as a diff.
			const fact = entry(`${today()} 10:00:00`, "dddd4444", "- Prefers tea.");
			fs.appendFileSync(path.join(me, "MEMORY.md"), `\n\n${fact}`);
			const next = await agentStart(fire);
			assert.strictEqual(next.section, start.section, "system section unchanged");
			assert.ok(next.result.message.content.includes("Late note."));
			assert.ok(next.result.message.content.includes("## MEMORY.md: new entries\n" + fact));
		} finally {
			await fire("session_shutdown", { reason: "quit" });
		}
	});

	it("rebuilds from the branch on resume and re-snapshots after compaction", async () => {
		const { fire } = await load();
		await fire("session_start", { reason: "resume" });
		try {
			// Resume: same pinned section as the original session, no repeated snapshot.
			const resumed = await agentStart(fire);
			assert.ok(resumed.section.includes("Northwind Labs") && !resumed.section.includes("Prefers tea"), "pin restored from the branch");
			assert.strictEqual(resumed.result, undefined, "nothing new since the last saved message");

			// A write while closed arrives as a diff only.
			const gap = entry(`${today()} 11:00:00`, "eeee5555", "Written while closed.");
			fs.appendFileSync(todayFile(), `\n\n${gap}`);
			const after = await agentStart(fire);
			assert.ok(after.result.message.content.includes(gap));
			assert.ok(!after.result.message.content.includes("Morning work."));

			// Compaction: the next run sends a full snapshot again, even when the event
			// fires before the compaction entry is on the branch.
			await fire("session_compact", { reason: "manual" });
			entries.push({ type: "compaction", summary: "s", firstKeptEntryId: "x" });
			const snap = await agentStart(fire);
			assert.strictEqual(snap.result.message.details.kind, "snapshot");
			assert.ok(snap.result.message.content.includes("Morning work."));
			assert.ok(snap.result.message.content.includes("Prefers tea"), "MEMORY.md changes since the pin are included");
		} finally {
			await fire("session_shutdown", { reason: "quit" });
		}
	});
	it("sends a change again when Pi did not save the message (regression)", async () => {
		const { fire } = await load();
		await fire("session_start", { reason: "resume" });
		try {
			const lost = entry(`${today()} 12:00:00`, "gggg7777", "Change in a rejected draft.");
			fs.appendFileSync(todayFile(), `\n\n${lost}`);
			const rejected = await turnEnd(fire, [{}], false);
			assert.ok(rejected.entries[0].content.includes(lost));
			const again = await turnEnd(fire);
			assert.ok(again?.entries?.[0]?.content.includes(lost), "re-sent after the draft was not saved");
			assert.strictEqual(await turnEnd(fire), undefined, "saved now: not sent a third time");

			const dropped = entry(`${today()} 12:05:00`, "gggg7777", "Change in an aborted run start.");
			fs.appendFileSync(todayFile(), `\n\n${dropped}`);
			const first = await agentStart(fire, false);
			assert.ok(first.result.message.content.includes(dropped));
			const retry = await agentStart(fire);
			assert.ok(retry.result?.message?.content.includes(dropped), "re-sent at the next prompt");
		} finally {
			await fire("session_shutdown", { reason: "quit" });
		}
	});

	it("steers a fresh snapshot after a mid-run compaction, exactly once (regression)", async () => {
		const { fire, sent } = await load();
		await fire("session_start", { reason: "resume" });
		try {
			assert.strictEqual(await turnEnd(fire), undefined, "mid-run, nothing changed");
			entries.push({ type: "compaction", summary: "s", firstKeptEntryId: "x" });
			await fire("session_compact", { reason: "threshold", willRetry: false });
			assert.strictEqual(sent.length, 1, "snapshot steered for the next model call");
			assert.strictEqual(sent[0].options.deliverAs, "steer");
			assert.strictEqual(sent[0].message.details.kind, "snapshot");
			assert.ok(sent[0].message.content.includes("Morning work."));

			const queued = entry(`${today()} 12:10:00`, "hhhh8888", "Written while the snapshot is queued.");
			fs.appendFileSync(todayFile(), `\n\n${queued}`);
			assert.strictEqual(await turnEnd(fire), undefined, "no second message while the steer is queued");

			entries.push({ type: "custom_message", ...sent[0].message }); // Pi saves it at message_end
			const next = await turnEnd(fire);
			assert.ok(next.entries[0].content.includes(queued), "later change arrives as a diff");
			assert.strictEqual(next.entries[0].details.kind, "update");
		} finally {
			await fire("session_shutdown", { reason: "quit" });
		}
	});

	it("does not steer after a finished run; the next prompt sends the snapshot (regression)", async () => {
		const { fire, sent } = await load();
		await fire("session_start", { reason: "resume" });
		try {
			await turnEnd(fire, []);
			await fire("agent_end", {});
			entries.push({ type: "compaction", summary: "s", firstKeptEntryId: "y" });
			await fire("session_compact", { reason: "threshold", willRetry: false });
			assert.strictEqual(sent.length, 0, "a steer here would start an extra model call");
			const start = await agentStart(fire);
			assert.strictEqual(start.result.message.details.kind, "snapshot");
		} finally {
			await fire("session_shutdown", { reason: "quit" });
		}
	});

	it("steers before an overflow retry, and recovers if the run aborts first (regression)", async () => {
		const { fire, sent } = await load();
		await fire("session_start", { reason: "resume" });
		try {
			await fire("agent_end", {});
			entries.push({ type: "compaction", summary: "s", firstKeptEntryId: "z" });
			await fire("session_compact", { reason: "overflow", willRetry: true });
			assert.strictEqual(sent.length, 1);
			assert.strictEqual(sent[0].message.details.kind, "snapshot");
			// The retry is aborted and the queue is cleared: the steer is never saved.
			await fire("agent_end", {});
			const start = await agentStart(fire);
			assert.strictEqual(start.result.message.details.kind, "snapshot", "the next prompt sends the snapshot");
		} finally {
			await fire("session_shutdown", { reason: "quit" });
		}
	});

	it("uses one clock reading for both dates at midnight", async () => {
		const { fire } = await load();
		const beforeMidnight = Date.parse("2030-05-01T23:59:59.999Z");
		fs.writeFileSync(dailyPath(path.join(me, "daily"), "2030-04-30"), "Prior day.");
		fs.writeFileSync(dailyPath(path.join(me, "daily"), "2030-05-01"), "Day just ending.");
		await fire("session_start", { reason: "resume" });
		const RealDate = Date;
		let clockReads = 0;
		try {
			globalThis.Date = class extends RealDate {
				constructor(value?: number) {
					super(value ?? (beforeMidnight + clockReads++));
				}
			} as DateConstructor;
			const { result } = await agentStart(fire, false);
			assert.strictEqual(clockReads, 1);
			assert.ok(result?.message?.content.includes("## Daily log 2030-05-01"));
			assert.ok(result?.message?.content.includes("## Daily log 2030-04-30"));
		} finally {
			globalThis.Date = RealDate;
			await fire("session_shutdown", { reason: "quit" });
		}
	});
});

// --- Pinned context files (config.contextFiles) in system-delta ---

describe("readContextFiles and formatPinnedContext", () => {
	it("reads the configured files in order and leaves out unsafe, duplicate, missing, blank and MEMORY.md entries", () => {
		const tmp = makeTempDir();
		try {
			const config = makeConfig(tmp, { contextFiles: ["SOUL.md", "../escape.md", "/etc/hostname", "missing.md", "blank.md", "MEMORY.md", "./SOUL.md", "notes/tools.md"] });
			fs.mkdirSync(path.join(config.memoryDir, "notes"), { recursive: true });
			fs.writeFileSync(path.join(config.memoryDir, "SOUL.md"), "I am Marlow.");
			fs.writeFileSync(path.join(config.memoryDir, "blank.md"), "  \n");
			fs.writeFileSync(path.join(config.memoryDir, "MEMORY.md"), "- fact");
			fs.writeFileSync(path.join(config.memoryDir, "notes", "tools.md"), "Use rg.");
			fs.writeFileSync(path.join(tmp, "escape.md"), "outside");
			assert.deepStrictEqual(readContextFiles(config), [
				{ name: "SOUL.md", content: "I am Marlow." },
				{ name: "notes/tools.md", content: "Use rg." },
			]);
		} finally {
			cleanup(tmp);
		}
	});

	it("formats one heading per file and cuts a long file with a pointer to that file", () => {
		assert.strictEqual(formatPinnedContext([]), "");
		const long = Array.from({ length: 2000 }, (_, i) => `Rule ${i}.`).join("\n");
		const out = formatPinnedContext([{ name: "SOUL.md", content: "Short." }, { name: "tools.md", content: long }], 500);
		assert.ok(out.startsWith(`${CONTEXT_FILES_INTRO}\n\n## SOUL.md\n\nShort.\n\n## tools.md\n\nRule 0.`));
		assert.ok(out.endsWith("… (tools.md continues; read it with memory_read(target='file', filename='tools.md').)"));
		const toolsBody = out.slice(out.indexOf("## tools.md\n\n") + "## tools.md\n\n".length);
		assert.ok(toolsBody.length <= 500, `tools.md body is ${toolsBody.length} chars`);
	});

	it("restores pinned context files from a snapshot and ignores malformed ones", () => {
		const baseline = { daily: {} };
		const msg = (pinnedContext: unknown) => ({ type: "custom_message", customType: DELTA_MESSAGE_TYPE, details: { v: DELTA_DETAILS_VERSION, kind: "snapshot", baseline, pinnedContext } });
		assert.deepStrictEqual(rebuildDeltaState([msg([{ name: "SOUL.md", content: "x" }])]).pinnedContext, [{ name: "SOUL.md", content: "x" }]);
		assert.deepStrictEqual(rebuildDeltaState([msg([])]).pinnedContext, [], "an empty pin is still a pin");
		assert.strictEqual(rebuildDeltaState([msg([{ name: 1, content: "x" }])]).pinnedContext, null);
		assert.strictEqual(rebuildDeltaState([msg(undefined)]).pinnedContext, null, "older snapshots have no pin");
	});
});

describe("system-delta pinned context files", () => {
	let tmp: string;
	let me: string;
	let saved: NodeJS.ProcessEnv;
	const entries: any[] = [];
	const ctx: any = {
		hasUI: false,
		modelRegistry: null,
		ui: { setWidget: () => {}, notify: () => {} },
		sessionManager: { getBranch: () => entries, getSessionId: () => "01a1ef4c-30aa-717b-8ffe-64244f09759a" },
	};

	async function load(mode?: string) {
		if (mode) process.env.PI_MEMORY_CONTEXT_MODE = mode;
		else delete process.env.PI_MEMORY_CONTEXT_MODE;
		const handlers: Record<string, Function[]> = {};
		const fakePi: any = {
			on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
			registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {},
			registerFlag: () => {}, getFlag: () => undefined, sendMessage: () => {}, sendUserMessage: () => {}, setStatus: () => {},
		};
		const mod = await import(`../index.ts?context=${Date.now()}-${Math.random()}`);
		mod.default(fakePi);
		const fire = async (name: string, event: any = {}) => {
			let result: any;
			for (const h of handlers[name] ?? []) result = await h(event, ctx);
			return result;
		};
		await fire("session_start", { reason: "startup" });
		const start = async () => {
			const event: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: {} };
			const result = await fire("before_agent_start", event);
			if (result?.message) entries.push({ type: "custom_message", ...result.message });
			return { result, section: event.systemPromptOptions.sections.pi_mem_memory as string | undefined };
		};
		return { fire, start, stop: () => fire("session_shutdown", { reason: "quit" }) };
	}

	before(() => {
		saved = { ...process.env };
		for (const k of Object.keys(process.env)) if (k.startsWith("PI_")) delete process.env[k];
		tmp = makeTempDir();
		me = path.join(tmp, "memory");
		fs.mkdirSync(path.join(me, "daily"), { recursive: true });
		fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Works at Northwind Labs.");
		fs.writeFileSync(path.join(me, "SOUL.md"), "You are Marlow.");
		fs.writeFileSync(path.join(me, "tools.md"), "Use rg first.");
		fs.writeFileSync(path.join(tmp, "escape.md"), "OUTSIDE THE MEMORY DIR");
		fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system-delta", autocommit: false, contextFiles: ["SOUL.md", "tools.md", "../escape.md"] }));
		process.env.PI_MEMORY_DIR = me;
		process.env.PI_TIMEZONE = "UTC";
		process.env.PI_MEMORY_RECALL = "0";
	});

	after(() => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		delete (globalThis as any).__piMemSystemSection;
		cleanup(tmp);
	});

	it("pins the context files in the section at session start and keeps them for the session", async () => {
		const { start, stop } = await load();
		try {
			const first = await start();
			const section = first.section!;
			assert.ok(section.startsWith(`${CONTEXT_FILES_INTRO}\n\n## SOUL.md\n\nYou are Marlow.\n\n## tools.md\n\nUse rg first.`));
			assert.ok(section.indexOf("## tools.md") < section.indexOf("STORED MEMORY ABOUT THE USER"), "context files come before stored memory");
			assert.ok(!section.includes("OUTSIDE THE MEMORY DIR"), "a path outside the memory directory is not read");
			assert.deepStrictEqual(first.result.message.details.pinnedContext.map((f: any) => f.name), ["SOUL.md", "tools.md"]);
			assert.ok(!first.result.message.content.includes("You are Marlow."), "context files are not repeated in the snapshot message");

			fs.writeFileSync(path.join(me, "SOUL.md"), "You are someone else.");
			const later = await start();
			assert.strictEqual(later.section, section, "an edit does not change the section mid-session");
			assert.strictEqual(later.result, undefined, "context files are pinned, not diffed");
		} finally {
			await stop();
		}
	});

	it("restores the same pinned files on resume and after compaction", async () => {
		const resumed = await load();
		try {
			const r = await resumed.start();
			assert.ok(r.section!.includes("You are Marlow.") && !r.section!.includes("someone else"), "pin restored from the branch");
			entries.push({ type: "compaction", summary: "s", firstKeptEntryId: "x" });
			await resumed.fire("session_compact", { reason: "manual", willRetry: false });
			const snap = await resumed.start();
			assert.strictEqual(snap.result.message.details.kind, "snapshot");
			assert.deepStrictEqual(snap.result.message.details.pinnedContext[0], { name: "SOUL.md", content: "You are Marlow." });
			assert.strictEqual(snap.section, r.section);
		} finally {
			await resumed.stop();
		}
	});

	it("a new session pins the edited files", async () => {
		entries.length = 0;
		const fresh = await load();
		try {
			const s = await fresh.start();
			assert.ok(s.section!.includes("You are someone else."));
		} finally {
			await fresh.stop();
		}
	});

	it("does not add context files to the system or system-lean section", async () => {
		for (const mode of ["system", "system-lean"]) {
			const other = await load(mode);
			try {
				const s = await other.start();
				assert.ok(s.section && s.section.includes("Northwind Labs"), `${mode}: memory section present`);
				assert.ok(!s.section.includes("CONTEXT FILES") && !s.section.includes("someone else"), `${mode}: no context files`);
			} finally {
				await other.stop();
			}
		}
	});
});

// --- Edge-case audit regressions (#4 and #5) ---

describe("edge-case audit regressions (lib)", () => {
	it("writeFileAtomic replaces content atomically and leaves no temp files", () => {
		const dir = makeTempDir();
		try {
			const file = path.join(dir, "MEMORY.md");
			writeFileAtomic(file, "first");
			assert.strictEqual(fs.readFileSync(file, "utf-8"), "first");
			const ino1 = fs.statSync(file).ino;
			writeFileAtomic(file, "secon");
			assert.strictEqual(fs.readFileSync(file, "utf-8"), "secon");
			const ino2 = fs.statSync(file).ino;
			assert.notStrictEqual(ino2, ino1, "atomic rename replaces the inode");
			assert.deepStrictEqual(fs.readdirSync(dir), ["MEMORY.md"], "no leftover temp files");
		} finally {
			cleanup(dir);
		}
	});

	it("condenseHead respects tiny maxChars and avoids splitting UTF-16 surrogate pairs", () => {
		const tiny = formatPinnedContext([{ name: "SOUL.md", content: "A".repeat(500) }], 50);
		const tinyBody = tiny.slice(tiny.indexOf("## SOUL.md\n\n") + "## SOUL.md\n\n".length);
		assert.ok(tinyBody.length <= 50, `expected <= 50 chars, got ${tinyBody.length}`);
		assert.strictEqual(condenseMemoryBody("A".repeat(500), 20).length, 20);
		assert.strictEqual(condenseMemoryBody("A".repeat(500), 0), "");

		for (const cap of [149, 150, 151]) {
			const out = formatPinnedContext([{ name: "a.md", content: "😺".repeat(200) }], cap);
			assert.strictEqual(out.toWellFormed(), out, `cap=${cap} must stay valid UTF-16`);
			const body = out.slice(out.indexOf("## a.md\n\n") + "## a.md\n\n".length);
			assert.ok(body.length <= cap, `cap=${cap} body length ${body.length}`);
		}
	});

	it("readContextFiles excludes MEMORY.md case-insensitively", () => {
		const dir = makeTempDir();
		try {
			const config = makeConfig(dir, { contextFiles: ["memory.md", "Memory.MD", "SOUL.md"] });
			fs.mkdirSync(config.memoryDir, { recursive: true });
			fs.writeFileSync(path.join(config.memoryDir, "memory.md"), "lower");
			fs.writeFileSync(path.join(config.memoryDir, "Memory.MD"), "mixed");
			fs.writeFileSync(path.join(config.memoryDir, "SOUL.md"), "Marlow");
			assert.deepStrictEqual(readContextFiles(config), [{ name: "SOUL.md", content: "Marlow" }]);
		} finally {
			cleanup(dir);
		}
	});

	it("keeps addedLines and removedCount when reorderedLines spans a large file", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `- Existing durable fact number ${i} with enough padding to fill the budget.`);
		const before = lines.join("\n");
		const after = [
			...lines.slice(1, 199),
			lines[0],
			"- Brand new critical fact.",
		].join("\n");
		const change = diffTracked(trackState(before), after, NONE);
		assert.strictEqual(change.kind, "revised");
		const section = formatChangeSection("MEMORY.md", change, "memory_read(target='long_term')");
		assert.ok(section);
		const rendered = renderSections([section], 1200, "… (earlier changes omitted)");
		assert.ok(rendered.length <= 1200, `rendered ${rendered.length} chars`);
		assert.ok(rendered.includes("New or changed lines:\n- Brand new critical fact."), "addedLines must not be clipped");
		assert.ok(rendered.includes("1 earlier line was removed or changed"), "removedCount must not be clipped");
	});

	it("does not let an own entry suppress the same line added by another session in a revised diff", () => {
		const mine = entry("2026-11-19 10:00:00", "aaaa1111", "- Shared bullet");
		const other = entry("2026-11-19 10:01:00", "bbbb2222", "- Shared bullet\n- Other line");
		const own = new Set([entryHash(mine)]);
		const change = diffTracked(trackState("# Old heading\n- base"), `# New heading\n- base\n\n${mine}\n\n${other}`, own);
		assert.strictEqual(change.kind, "revised");
		assert.ok(change.addedLines.includes("- Shared bullet"), "other session's line kept even when own entry had the same line");
		assert.ok(change.addedLines.includes("- Other line"));
	});

	it("rebuildDeltaState restores multi-hash ownEntryHashes and keeps newer ownMemoryState over a delayed snapshot", () => {
		const oldMem = trackState("# M\n- old");
		const newMem = trackState("# M\n- overwritten");
		const state = rebuildDeltaState([
			{ type: "compaction", summary: "s", firstKeptEntryId: "x" },
			{ type: "message", message: { role: "toolResult", toolName: "memory_write", details: { ownEntryHash: "h1", ownEntryHashes: ["h1", "h2"] } } },
			{ type: "message", message: { role: "toolResult", toolName: "memory_write", details: { ownMemoryState: newMem, writtenAt: 2000 } } },
			{ type: "custom_message", customType: DELTA_MESSAGE_TYPE, details: { v: DELTA_DETAILS_VERSION, kind: "snapshot", baseline: { daily: {}, memory: oldMem }, createdAt: 1000 } },
		]);
		assert.ok(state.own.has("h1") && state.own.has("h2"), "all split hashes restored");
		assert.deepStrictEqual(state.baseline?.memory, newMem, "delayed pre-overwrite snapshot does not roll back ownMemoryState");
	});
});

describe("edge-case audit regressions (handlers)", () => {
	let tmp: string;
	let me: string;
	let saved: NodeJS.ProcessEnv;
	let entries: any[];
	let idleState: boolean;
	let pendingMessages: boolean;
	const SESSION_ID = "01a1ef4c-30aa-717b-8ffe-64244f09759a";

	const makeCtx = () => ({
		hasUI: false,
		modelRegistry: null,
		ui: { setWidget: () => {}, notify: () => {} },
		isIdle: () => idleState,
		hasPendingMessages: () => pendingMessages,
		sessionManager: { getBranch: () => entries, getSessionId: () => SESSION_ID },
	});

	async function load(freshModule = true) {
		const handlers: Record<string, Function[]> = {};
		const tools: Record<string, any> = {};
		const sent: Array<{ message: any; options: any }> = [];
		const fakePi: any = {
			on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
			registerTool: (t: any) => { tools[t.name] = t; },
			registerCommand: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {},
			registerFlag: () => {}, getFlag: () => undefined,
			sendMessage: (message: any, options: any) => { sent.push({ message, options }); },
			sendUserMessage: () => {}, setStatus: () => {},
		};
		const mod = freshModule
			? await import(`../index.ts?audit=${Date.now()}-${Math.random()}`)
			: await import("../index.ts");
		mod.default(fakePi);
		const ctx = makeCtx();
		const fire = async (name: string, event: any = {}) => {
			let result: any;
			for (const h of handlers[name] ?? []) result = await h(event, ctx);
			return result;
		};
		const start = async (save = true) => {
			const event: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: {} };
			const result = await fire("before_agent_start", event);
			if (save && result?.message) entries.push({ type: "custom_message", ...result.message });
			return { result, section: event.systemPromptOptions.sections.pi_mem_memory as string };
		};
		const turnEnd = async (event: any = {}, save = true) => {
			const result = await fire("turn_end", { type: "turn_end", outcome: "completed", toolResults: [{}], entries: [], ...event });
			if (save) for (const e of result?.entries ?? []) entries.push(e);
			return result;
		};
		return { mod, ctx, tools, fire, start, turnEnd, sent };
	}

	const today = () => todayStr("UTC");
	const todayFile = () => dailyPath(path.join(me, "daily"), today());

	before(() => {
		saved = { ...process.env };
		for (const k of Object.keys(process.env)) if (k.startsWith("PI_")) delete process.env[k];
		tmp = makeTempDir();
		me = path.join(tmp, "memory");
		fs.mkdirSync(path.join(me, "daily"), { recursive: true });
		fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Pin v1.");
		fs.writeFileSync(path.join(me, "SOUL.md"), "Soul v1.");
		fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system-delta", autocommit: false, contextFiles: ["SOUL.md"] }));
		fs.writeFileSync(todayFile(), entry(`${today()} 08:00:00`, "aaaa1111", "Morning."));
		process.env.PI_MEMORY_DIR = me;
		process.env.PI_TIMEZONE = "UTC";
		process.env.PI_MEMORY_RECALL = "0";
		entries = [];
		idleState = false;
		pendingMessages = false;
	});

	after(() => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		delete (globalThis as any).__piMemSystemSection;
		cleanup(tmp);
	});

	it("restores branch pins in before_agent_start even when session_start did not fire", async () => {
		entries = [];
		const s1 = await load();
		await s1.fire("session_start", { reason: "startup" });
		const first = await s1.start();
		await s1.fire("session_shutdown", { reason: "reload" });

		// Disk changes before reload.
		fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Pin v2.");
		fs.writeFileSync(path.join(me, "SOUL.md"), "Soul v2.");

		// Headless reload: before_agent_start runs with no prior session_start.
		const s2 = await load();
		try {
			const turn1 = await s2.start();
			const turn2 = await s2.start();
			assert.strictEqual(turn1.section, first.section, "turn 1 must restore branch pins, not read v2 from disk");
			assert.strictEqual(turn2.section, first.section, "turn 2 must keep the exact same section");
		} finally {
			await s2.fire("session_shutdown", { reason: "quit" });
			fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Pin v1.");
			fs.writeFileSync(path.join(me, "SOUL.md"), "Soul v1.");
		}
	});

	it("resets pins on session_tree and session_switch, and keeps pre-pinnedContext branches cache-safe", async () => {
		entries = [];
		const s = await load();
		await s.fire("session_start", { reason: "startup" });
		try {
			const withContext = await s.start();
			assert.ok(withContext.section.includes("Soul v1."));

			// Navigate /tree to an older branch whose snapshot predates pinnedContext.
			entries = [{
				type: "custom_message",
				customType: DELTA_MESSAGE_TYPE,
				content: "",
				display: false,
				details: { v: DELTA_DETAILS_VERSION, kind: "snapshot", baseline: { daily: {}, memory: trackState("# Old") }, pinnedMemory: "# Old", id: "legacy-1" },
			}];
			await s.fire("session_tree", { newLeafId: "legacy-1" });
			const onLegacy = await s.start();
			assert.ok(onLegacy.section.includes("# Old"));
			assert.ok(!onLegacy.section.includes("Soul v1."), "legacy branch must not inherit pinnedContext from another branch");
			assert.ok(!onLegacy.section.includes("CONTEXT FILES"), "legacy snapshot without pinnedContext keeps empty context pin");

			// session_switch to an empty new session clears pins and reads current disk files.
			fs.writeFileSync(path.join(me, "SOUL.md"), "Soul after switch.");
			entries = [];
			await s.fire("session_switch", { reason: "new" });
			const fresh = await s.start();
			assert.ok(fresh.section.includes("Soul after switch."), "session_switch resets pins for the new session");
		} finally {
			await s.fire("session_shutdown", { reason: "quit" });
			fs.writeFileSync(path.join(me, "SOUL.md"), "Soul v1.");
		}
	});

	it("avoids steering on compaction when user messages are queued, continues on turn_end continue:true, and recovers from a dropped steer", async () => {
		entries = [];
		idleState = false;
		pendingMessages = false;
		const s = await load();
		await s.fire("session_start", { reason: "startup" });
		try {
			await s.start();

			// turn_end with continue:true and no toolResults still sets midRun and delivers diffs.
			const extra = entry(`${today()} 09:00:00`, "cccc3333", "During continuation.");
			fs.appendFileSync(todayFile(), `\n\n${extra}`);
			const cont = await s.turnEnd({ toolResults: [], continue: true });
			assert.ok(cont?.entries?.[0]?.content.includes(extra), "continue:true turn delivers diff");

			// Mid-run compaction while a user message is already queued does not steer.
			pendingMessages = true;
			entries.push({ type: "compaction", summary: "s", firstKeptEntryId: "x" });
			await s.fire("session_compact", { reason: "threshold", willRetry: false });
			assert.strictEqual(s.sent.length, 0, "skip steer when a user message is queued ahead of it");
			pendingMessages = false;

			// Next turn_end delivers the fresh snapshot instead.
			const snapAfter = await s.turnEnd();
			assert.strictEqual(snapAfter?.entries?.[0]?.details?.kind, "snapshot");

			// Pre-prompt overflow compaction steers, then aborts before agent_start (agent_end never fires).
			entries.push({ type: "compaction", summary: "s2", firstKeptEntryId: "y" });
			await s.fire("session_compact", { reason: "overflow", willRetry: true });
			assert.strictEqual(s.sent.length, 1);

			// Next prompt arrives while idle (steer was dropped without agent_end): must NOT lock out.
			idleState = true;
			const recovered = await s.start();
			assert.strictEqual(recovered.result?.message?.details?.kind, "snapshot", "recovers immediately when idle instead of locking out");
		} finally {
			idleState = false;
			pendingMessages = false;
			await s.fire("session_shutdown", { reason: "quit" });
		}
	});

	it("strips own writes with embedded headers and nested tool calls without echoing back", async () => {
		entries = [];
		const s = await load();
		await s.fire("session_start", { reason: "startup" });
		try {
			await s.start();

			// Embedded ENTRY_HEADER inside memory_write content.
			const embedded = `Summary\n${entry(`${today()} 07:00:00`, "99999999", "Quoted earlier entry.")}`;
			const res = await s.tools.memory_write.execute("call-emb", { target: "daily", content: embedded }, undefined, undefined, s.ctx);
			assert.ok(Array.isArray(res.details.ownEntryHashes) && res.details.ownEntryHashes.length === 2);
			entries.push({ type: "message", message: { role: "toolResult", toolName: "memory_write", details: res.details } });
			assert.strictEqual(await s.turnEnd(), undefined, "multi-block own write is stripped");

			// Nested tool call (no top-level toolResult pushed to entries) while a delta message was just saved.
			const other = entry(`${today()} 09:30:00`, "dddd4444", "Other session before nested.");
			fs.appendFileSync(todayFile(), `\n\n${other}`);
			await s.start(); // leaves delta.pending set for the saved update
			await s.tools.memory_write.execute("call-nested", { target: "daily", content: "Nested codemode write." }, undefined, undefined, s.ctx);
			assert.strictEqual(await s.turnEnd(), undefined, "nested own write survives settlePending");
		} finally {
			await s.fire("session_shutdown", { reason: "quit" });
		}
	});

	it("restores parent __piMemSystemSection on sub-agent shutdown and reloads .pi-mem.json per factory call", async () => {
		entries = [];
		const parent = await load(false);
		await parent.fire("session_start", { reason: "startup" });
		await parent.start();
		const parentSection = (globalThis as any).__piMemSystemSection as string;
		assert.ok(parentSection.includes("Soul v1."));

		// Update .pi-mem.json and spin up an in-process sub-agent using the SAME cached module.
		fs.writeFileSync(path.join(me, "EXTRA.md"), "Sub-agent extra context.");
		fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system-delta", autocommit: false, contextFiles: ["SOUL.md", "EXTRA.md"] }));
		const sub = await load(false);
		try {
			const subSection = (globalThis as any).__piMemSystemSection as string;
			assert.ok(subSection.includes("Sub-agent extra context."), "new session reads updated .pi-mem.json");
		} finally {
			await sub.fire("session_shutdown", { reason: "quit" });
		}

		// After sub-agent shuts down, parent getter is restored.
		assert.strictEqual((globalThis as any).__piMemSystemSection, parentSection);
		await parent.fire("session_shutdown", { reason: "quit" });
		fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system-delta", autocommit: false, contextFiles: ["SOUL.md"] }));
	});

	it("detects same-size atomic renames with preserved mtime via statSignature inode tracking", async () => {
		entries = [];
		const s = await load();
		await s.fire("session_start", { reason: "startup" });
		try {
			await s.start();
			const memPath = path.join(me, "MEMORY.md");
			const original = fs.readFileSync(memPath, "utf-8");
			const origStat = fs.statSync(memPath);
			// Replace MEMORY.md with a same-length file carrying the exact same mtime.
			const replaced = original.replace("Pin v1.", "Pin v9.");
			assert.strictEqual(replaced.length, original.length);
			const tmpFile = path.join(me, ".same-size.tmp");
			fs.writeFileSync(tmpFile, replaced, "utf-8");
			fs.utimesSync(tmpFile, origStat.atime, origStat.mtime);
			fs.renameSync(tmpFile, memPath);

			const update = await s.turnEnd();
			assert.ok(update?.entries?.[0]?.content.includes("Pin v9."), "inode change defeats stale size+mtime signature");
		} finally {
			await s.fire("session_shutdown", { reason: "quit" });
			fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Pin v1.");
		}
	});

	it("skips rebuildDelta and preserves lastSignature when settlePending confirms a saved message", async () => {
		entries = [];
		const s = await load();
		await s.fire("session_start", { reason: "startup" });
		try {
			await s.start(); // saves snapshot and sets delta.pending + delta.lastSignature
			let branchReads = 0;
			const origGetBranch = s.ctx.sessionManager.getBranch;
			s.ctx.sessionManager.getBranch = () => { branchReads++; return origGetBranch(); };
			try {
				// Confirmed save: settlePending reads branch once to confirm id and skips rebuildDelta.
				assert.strictEqual(await s.turnEnd(), undefined);
				assert.strictEqual(branchReads, 1, "confirmed save must not re-run rebuildDelta");
				// Subsequent unchanged turn hits lastSignature with zero branch reads.
				assert.strictEqual(await s.turnEnd(), undefined);
				assert.strictEqual(branchReads, 1);
			} finally {
				s.ctx.sessionManager.getBranch = origGetBranch;
			}
		} finally {
			await s.fire("session_shutdown", { reason: "quit" });
		}
	});
});
