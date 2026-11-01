import { describe, it } from "node:test";
import assert from "node:assert";
import { condenseMemoryBody, formatRecallBlock, MEMORY_BLOCK_MAX_CHARS, approxTokens } from "../lib.ts";

// System mode puts two things in front of the model: a condensed MEMORY.md in
// the cached system prompt, and a condensed per-turn retrieval block. Each is
// held to about 3K tokens (~12K chars). Anything cut is replaced by an ellipsis
// and a pointer to memory_read(target='long_term') / memory_search, so the
// model knows there is more and how to get it.

describe("condenseMemoryBody", () => {
	it("returns a short file untouched, with no pointer", () => {
		const body = "# Memory\n- Works at Northwind Labs.\n- Daughter Nalini, 8.\n";
		assert.strictEqual(condenseMemoryBody(body), body.trim());
	});

	it("hard-truncates a long file at a line boundary, adds an ellipsis and the memory_read nudge, and stays within the budget", () => {
		const line = "- A durable fact about the user that takes up some room on the line.\n";
		const body = line.repeat(400); // ~28K chars
		const out = condenseMemoryBody(body);
		assert.ok(out.length <= MEMORY_BLOCK_MAX_CHARS, `condensed is ${out.length} chars`);
		assert.ok(approxTokens(out) <= 3000, `~${approxTokens(out)} tokens`);
		assert.ok(out.includes("…"), "ellipsis marks the cut");
		assert.ok(out.includes("memory_read(target='long_term')"), "points the model at the full file");
		// Cut on a line boundary: the kept part ends with a complete line, not a fragment.
		const kept = out.slice(0, out.indexOf("…")).trimEnd();
		assert.ok(kept.endsWith("on the line."), `kept part ends mid-line: ...${kept.slice(-40)}`);
	});

	it("keeps the BEGINNING of the file (chronological; later entries supersede, so the tail is what gets read on demand)", () => {
		const body = Array.from({ length: 600 }, (_, i) => `- entry ${i}`).join("\n");
		const out = condenseMemoryBody(body);
		assert.ok(out.startsWith("- entry 0"));
	});
});

describe("formatRecallBlock budget", () => {
	it("caps the per-turn block near 3K tokens, drops whole items rather than fragments, and adds a memory_search nudge when it cut", () => {
		const long = "x".repeat(300);
		const fileLines = Array.from({ length: 120 }, (_, i) => ({ file: `notes/n${i}.md`, line: i + 1, text: `${i} ${long}` }));
		const conversations = Array.from({ length: 60 }, (_, i) => ({ content: `${i} ${long}`, role: "user", created_at: "2026-10-01T00:00:00Z", distance: 0.2 }));
		const out = formatRecallBlock({ fullMemory: undefined, fileLines, conversations, facts: [] });
		assert.ok(approxTokens(out) <= 3000, `~${approxTokens(out)} tokens`);
		assert.ok(out.includes("…"), "ellipsis marks the cut");
		assert.ok(/memory_search/.test(out), "points the model at the search tool");
		// No half items: every bullet is complete.
		for (const b of out.split("\n").filter(l => l.startsWith("- "))) assert.ok(b.length < 400, "a bullet was cut mid-way");
	});

	it("is unchanged when the block is already small", () => {
		const out = formatRecallBlock({ fullMemory: undefined, fileLines: [{ file: "notes/a.md", line: 1, text: "likes tea" }], conversations: [], facts: [] });
		assert.ok(out.includes("likes tea"));
		assert.ok(!out.includes("…"));
	});
});

describe("condenseDailyLogs (system mode, per turn)", () => {
	it("returns today's and yesterday's log, newest first, untouched when small", async () => {
		const { condenseDailyLogs, DAILY_BLOCK_MAX_CHARS } = await import("../lib.ts");
		const out = condenseDailyLogs({ today: "2026-11-01", yesterday: "2026-10-31" }, { "2026-11-01": "- planned the Agra trip", "2026-10-31": "- fixed the connect button" });
		assert.ok(out.indexOf("2026-11-01") < out.indexOf("2026-10-31"), "today before yesterday");
		assert.ok(out.includes("Agra") && out.includes("connect button"));
		assert.ok(!out.includes("…"));
		assert.ok(out.length <= DAILY_BLOCK_MAX_CHARS);
	});

	it("keeps the END of a long day (latest entries), cuts at a line boundary, caps at 2K chars, and nudges memory_read(target='daily')", async () => {
		const { condenseDailyLogs, DAILY_BLOCK_MAX_CHARS } = await import("../lib.ts");
		assert.strictEqual(DAILY_BLOCK_MAX_CHARS, 2000);
		const lines = Array.from({ length: 300 }, (_, i) => `- ${String(i).padStart(3, "0")} something that happened during the day, in some detail`).join("\n");
		const out = condenseDailyLogs({ today: "2026-11-01", yesterday: "2026-10-31" }, { "2026-11-01": lines, "2026-10-31": lines });
		assert.ok(out.length <= DAILY_BLOCK_MAX_CHARS, `${out.length} chars`);
		assert.ok(out.includes("…"));
		assert.ok(out.includes("memory_read(target='daily')"));
		assert.ok(out.includes("- 299 something"), "the latest entry of today is kept");
		assert.ok(!out.includes("- 000 something"), "the oldest entry of today is cut first");
		// a kept fragment never starts mid-line
		for (const l of out.split("\n")) if (l.startsWith("something")) assert.fail(`mid-line fragment: ${l.slice(0, 40)}`);
	});

	it("is empty when there are no logs", async () => {
		const { condenseDailyLogs } = await import("../lib.ts");
		assert.strictEqual(condenseDailyLogs({ today: "2026-11-01", yesterday: "2026-10-31" }, {}), "");
	});
});
