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
