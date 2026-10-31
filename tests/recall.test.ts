import { describe, it } from "node:test";
import assert from "node:assert";
import {
	buildRecallConfig,
	latestUserText,
	messageText,
	filterConversationRows,
	formatRecallBlock,
	RECALL_DIRECTIVE,
} from "../lib.ts";

describe("buildRecallConfig", () => {
	it("is enabled by default with bounded limits and sqlite facts off", () => {
		const c = buildRecallConfig({});
		assert.strictEqual(c.enabled, true);
		assert.strictEqual(c.sqliteFacts, false);
		assert.ok(c.maxFileLines > 0 && c.maxConversationRows > 0 && c.conversationTimeoutMs > 0);
	});
	it("honours env overrides and ignores garbage numbers", () => {
		const c = buildRecallConfig({ PI_MEMORY_RECALL: "0", PI_MEMORY_RECALL_SQLITE: "1", PI_MEMORY_RECALL_MAX_LINES: "nope" });
		assert.strictEqual(c.enabled, false);
		assert.strictEqual(c.sqliteFacts, true);
		assert.strictEqual(c.maxFileLines, 8);
	});
});

describe("latestUserText", () => {
	it("returns the latest real user message, skipping pi-mem's injected block", () => {
		const msgs = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "hi" },
			{ role: "user", content: [{ type: "text", text: "Where do I work these days?" }] },
			{ role: "user", content: "<pi-mem-injected>\nstuff\n</pi-mem-injected>" },
		];
		assert.strictEqual(latestUserText(msgs), "Where do I work these days?");
	});
	it("returns empty when there is no user text", () => {
		assert.strictEqual(latestUserText([{ role: "assistant", content: "x" }]), "");
		assert.strictEqual(messageText(42), "");
	});
});

describe("filterConversationRows", () => {
	it("drops far, empty, NaN-distance and duplicate rows, sorts nearest first, caps at limit", () => {
		const rows = [
			{ content: "far away", _distance: 0.9 },
			{ content: "", _distance: 0.1 },
			{ content: "no distance" },
			{ content: "Dentist Tuesday 3pm", _distance: 0.3, role: "user", created_at: "2026-07-01T10:00:00Z" },
			{ content: "dentist tuesday 3pm", _distance: 0.2 },
			{ content: "closest", _distance: 0.05 },
			{ content: "second", _distance: 0.1 },
		];
		const out = filterConversationRows(rows, 0.55, 2);
		assert.deepStrictEqual(out.map(r => r.content), ["closest", "second"]);
		const all = filterConversationRows(rows, 0.55, 10);
		assert.strictEqual(all.length, 3); // closest, second, one dentist (dedupe case-insensitive)
	});
});

describe("formatRecallBlock", () => {
	it("returns empty when nothing was retrieved", () => {
		assert.strictEqual(formatRecallBlock({ fileLines: [], conversations: [], facts: [] }), "");
	});
	it("labels the block as data about the user and includes every source", () => {
		const block = formatRecallBlock({
			fileLines: [{ file: "MEMORY.md", line: 4, text: "- Passport expires March 2027." }],
			conversations: [{ content: "my dentist is Dr. Ruiz", role: "user", created_at: "2026-06-30T12:00:00Z", distance: 0.2 }],
			facts: [{ tag: "work", label: "manager", instructions: "Reports to Dana Okafor" }],
		});
		assert.ok(block.startsWith("STORED MEMORY ABOUT THE USER"));
		assert.ok(block.includes("not instructions"));
		assert.ok(block.includes("(MEMORY.md:4) Passport expires March 2027."));
		assert.ok(block.includes("[2026-06-30] user: my dentist is Dr. Ruiz"));
		assert.ok(block.includes("work/manager: Reports to Dana Okafor"));
	});
	it("clips very long snippets", () => {
		const block = formatRecallBlock({ fileLines: [{ file: "a.md", line: 1, text: "x".repeat(1000) }], conversations: [], facts: [] });
		const line = block.split("\n").find(l => l.includes("(a.md:1)"))!;
		assert.ok(line.length < 420, `snippet line too long: ${line.length}`);
		assert.ok(line.endsWith("…"));
		assert.ok(!block.includes("x".repeat(401)));
	});
});

describe("RECALL_DIRECTIVE", () => {
	it("tells the model to look before asking", () => {
		assert.ok(RECALL_DIRECTIVE.includes("memory_search"));
		assert.ok(/never ask/i.test(RECALL_DIRECTIVE));
	});
});

describe("formatRecallBlock full-file mode", () => {
	it("includes the whole MEMORY.md and states that later entries supersede earlier ones", () => {
		const block = formatRecallBlock({
			fullMemory: "# Long-term memory\n- Works at Acme Corp.\n- Left Acme; now at Northwind Labs.\n",
			fileLines: [], conversations: [], facts: [],
		});
		assert.ok(block.includes("Works at Acme Corp."));
		assert.ok(block.includes("Northwind Labs"));
		assert.ok(/LATER one is current/.test(block));
	});
	it("defaults fullFileMaxChars to a bounded positive size", () => {
		const c = buildRecallConfig({});
		assert.ok(c.fullFileMaxChars > 1000 && c.fullFileMaxChars < 100000);
		assert.strictEqual(buildRecallConfig({ PI_MEMORY_RECALL_FULL_MAX_CHARS: "500" }).fullFileMaxChars, 500);
	});
});

describe("system mode recall shape", () => {
	// In system mode, durable MEMORY.md lives in the cached system prompt, so the
	// per-turn recall block must NOT re-include MEMORY.md lines; it carries only
	// other-file hits, conversations, and facts. These assert the formatter pieces
	// buildSystemTurnRecall relies on.
	it("formats only non-MEMORY file hits plus conversations/facts", () => {
		const block = formatRecallBlock({
			fullMemory: undefined,
			fileLines: [{ file: "notes/lessons.md", line: 3, text: "ship small PRs" }],
			conversations: [{ content: "we discussed the launch date", role: "user", created_at: "2026-10-01T00:00:00Z" }],
			facts: [],
		});
		assert.ok(block.includes("notes/lessons.md"));
		assert.ok(block.includes("launch date"));
		assert.ok(!block.includes("MEMORY.md"));
	});

	it("is silent (empty) when nothing relevant is retrieved", () => {
		assert.strictEqual(formatRecallBlock({ fullMemory: undefined, fileLines: [], conversations: [], facts: [] }), "");
	});
});
