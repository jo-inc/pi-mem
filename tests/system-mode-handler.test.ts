import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanup } from "./helpers.ts";

// Regression: in system mode the before_agent_start handler wrote through
// event.systemPromptOptions.sections without checking it existed. A host that
// passes options with no `sections` (pi-sdk-wrapper did) made it throw a
// TypeError that Pi swallowed, so memory was silently never injected.

let tmp: string;
let handlers: Record<string, Function[]>;

before(async () => {
	tmp = makeTempDir();
	const me = path.join(tmp, "me");
	fs.mkdirSync(me, { recursive: true });
	fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Works at Northwind Labs as senior product designer.\n");
	fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system", autocommit: false }));
	process.env.PI_MEMORY_DIR = me;
	process.env.PI_MEMORY_RECALL = "0";
	handlers = {};
	const fakePi: any = {
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {},
		registerMessageRenderer: () => {}, registerFlag: () => {}, getFlag: () => undefined,
		sendMessage: () => {}, sendUserMessage: () => {}, setStatus: () => {},
	};
	const mod = await import(`../index.ts?t=${Date.now()}`);
	mod.default(fakePi);
});
after(() => { cleanup(tmp); delete (globalThis as any).__piMemSystemSection; });

describe("system-mode eager publish", () => {
	it("exposes the memory section as a live getter, before any handler fires", () => {
		// A host that builds its own prompt snapshots it when the run starts, before
		// before_agent_start runs, so the section must already be available here.
		const published = (globalThis as any).__piMemSystemSection;
		assert.ok(typeof published === "string" && published.includes("Northwind Labs"));
	});
});

describe("system-mode getter is live", () => {
	it("reflects memory written after the extension loaded", () => {
		const me = process.env.PI_MEMORY_DIR!;
		const file = path.join(me, "MEMORY.md");
		const before = fs.readFileSync(file, "utf-8");
		try {
			fs.writeFileSync(file, before + "\n- Daughter Nalini turns 8 on December 9.\n");
			const live = (globalThis as any).__piMemSystemSection as string;
			assert.ok(live.includes("Nalini"), "getter re-reads the file on access");
		} finally {
			fs.writeFileSync(file, before);
		}
	});
});

describe("system-mode before_agent_start", () => {
	it("does not throw when systemPromptOptions has no sections, and publishes the memory", () => {
		const h = handlers["before_agent_start"];
		assert.ok(h && h.length === 1, "handler registered");
		const event: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: {} };
		assert.doesNotThrow(() => h[0](event, {}));
		assert.ok(event.systemPromptOptions.sections, "sections created");
		const section = event.systemPromptOptions.sections.pi_mem_memory;
		assert.ok(typeof section === "string" && section.includes("Northwind Labs"), "memory in section");
		const published = (globalThis as any).__piMemSystemSection;
		assert.strictEqual(published, section, "same text exposed for hosts that build their own prompt");
	});
	it("still works when sections already exists", () => {
		const h = handlers["before_agent_start"][0];
		const event: any = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: { sections: { other: "x" } } };
		h(event, {});
		assert.strictEqual(event.systemPromptOptions.sections.other, "x");
		assert.ok(event.systemPromptOptions.sections.pi_mem_memory.includes("Northwind"));
	});
});

describe("system-mode per-turn injection", () => {
	it("injects only daily logs per turn, never a retrieval block from other files/conversations/facts", async () => {
		// System mode keeps MEMORY.md in the cached system prompt. Per turn it adds
		// ONLY today's/yesterday's daily logs; the old file/conversation/fact
		// retrieval block was removed because it read as noise on the smarter models.
		const me = process.env.PI_MEMORY_DIR!;
		fs.mkdirSync(path.join(me, "notes"), { recursive: true });
		fs.writeFileSync(path.join(me, "notes", "food.md"), "- Allergic to shellfish, especially shrimp.\n");
		const saved = { ...process.env };
		// Isolate from the developer's shell: any PI_* override (e.g. PI_DAILY_DIR)
		// would point the search at real memory files.
		for (const k of Object.keys(process.env)) if (k.startsWith("PI_") && k !== "PI_MEMORY_DIR") delete process.env[k];
		process.env.PI_MEMORY_RECALL = "1";
		process.env.PI_SPRITE_URL = "http://127.0.0.1:9";
		process.env.PI_MEMORY_RECALL_TIMEOUT_MS = "200";
		const local: Record<string, Function[]> = {};
		const fakePi: any = {
			on: (name: string, fn: Function) => { (local[name] ??= []).push(fn); },
			registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {},
			registerMessageRenderer: () => {}, registerFlag: () => {}, getFlag: () => undefined,
			sendMessage: () => {}, sendUserMessage: () => {}, setStatus: () => {},
		};
		try {
			const mod = await import(`../index.ts?recall=${Date.now()}`);
			mod.default(fakePi);
			const h = local["context"];
			assert.ok(h && h.length === 1, "context handler registered");
			// A query that would once have retrieved the shellfish line now injects
			// nothing: no daily log, and retrieval no longer runs per turn.
			const relevant = await h[0]({ messages: [{ role: "user", content: "book me a shrimp dinner", timestamp: 1 }] }, {});
			assert.strictEqual(relevant, undefined, "no retrieval block injected and no daily log: nothing injected");

			const irrelevant = await h[0]({ messages: [{ role: "user", content: "what time is it", timestamp: 2 }] }, {});
			assert.strictEqual(irrelevant, undefined, "no daily log: nothing injected");

			// With a daily log for today, the per-turn message carries it (tight, 2K cap).
			const { todayStr, dailyPath, buildConfig } = await import("../lib.ts");
			const cfg = buildConfig(process.env as any);
			fs.mkdirSync(cfg.dailyDir, { recursive: true });
			fs.writeFileSync(dailyPath(cfg.dailyDir, todayStr(cfg.timezone)), "- Booked the dentist for Thursday.\n");
			const withDaily = await h[0]({ messages: [{ role: "user", content: "what time is it", timestamp: 3 }] }, {});
			assert.ok(withDaily && Array.isArray(withDaily.messages), "daily block injected");
			const dailyInjected = String(withDaily.messages.at(-1).content);
			assert.ok(dailyInjected.includes("dentist"), "today's log present");
			assert.ok(!dailyInjected.includes("Northwind Labs"), "MEMORY.md not repeated");
			assert.ok(!dailyInjected.includes("shellfish"), "no file retrieval injected per turn");
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});
});

describe("system-lean mode", () => {
	it("publishes the cached memory section with a daily-log pointer, and injects nothing per turn", async () => {
		const me = makeTempDir();
		fs.mkdirSync(me, { recursive: true });
		fs.writeFileSync(path.join(me, "MEMORY.md"), "# Long-term memory\n- Works at Northwind Labs.\n");
		fs.writeFileSync(path.join(me, ".pi-mem.json"), JSON.stringify({ contextMode: "system-lean", autocommit: false }));
		const saved = { ...process.env };
		for (const k of Object.keys(process.env)) if (k.startsWith("PI_")) delete process.env[k];
		process.env.PI_MEMORY_DIR = me;
		const local: Record<string, Function[]> = {};
		const fakePi: any = {
			on: (name: string, fn: Function) => { (local[name] ??= []).push(fn); },
			registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {},
			registerMessageRenderer: () => {}, registerFlag: () => {}, getFlag: () => undefined,
			sendMessage: () => {}, sendUserMessage: () => {}, setStatus: () => {},
		};
		try {
			const mod = await import(`../index.ts?lean=${Date.now()}`);
			mod.default(fakePi);

			// Cached system section is present and names the daily-log tool.
			const section = (globalThis as any).__piMemSystemSection as string;
			assert.ok(section.includes("Northwind Labs"), "durable memory in the cached section");
			assert.ok(section.includes("memory_read(target='daily')"), "daily-log pointer present");

			// before_agent_start still populates the prompt section.
			const ev: any = { type: "before_agent_start", systemPromptOptions: {} };
			local["before_agent_start"][0](ev, {});
			assert.ok(ev.systemPromptOptions.sections.pi_mem_memory.includes("Northwind Labs"));

			// Per turn: nothing injected, even with a daily log on disk.
			const { todayStr, dailyPath, buildConfig } = await import("../lib.ts");
			const cfg = buildConfig(process.env as any);
			fs.mkdirSync(cfg.dailyDir, { recursive: true });
			fs.writeFileSync(dailyPath(cfg.dailyDir, todayStr(cfg.timezone)), "- Booked the dentist.\n");
			const h = local["context"][0];
			const out = await h({ messages: [{ role: "user", content: "what did I do today", timestamp: 1 }] }, {});
			assert.strictEqual(out, undefined, "system-lean injects nothing per turn");
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
			cleanup(me);
		}
	});
});
