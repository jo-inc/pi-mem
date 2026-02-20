import { describe, it } from "node:test";
import assert from "node:assert";
import { buildConfig } from "../lib.ts";

describe("buildConfig", () => {
	it("uses defaults when no env vars set", () => {
		const config = buildConfig({ HOME: "/home/testuser" });
		assert.strictEqual(config.memoryDir, "/home/testuser/.pi/agent/memory");
		assert.strictEqual(config.memoryFile, "/home/testuser/.pi/agent/memory/MEMORY.md");
		assert.strictEqual(config.scratchpadFile, "/home/testuser/.pi/agent/memory/SCRATCHPAD.md");
		assert.strictEqual(config.dailyDir, "/home/testuser/.pi/agent/memory/daily");
		assert.strictEqual(config.notesDir, "/home/testuser/.pi/agent/memory/notes");
		assert.strictEqual(config.sessionDir, "/home/testuser/.pi/agent/sessions");
		assert.deepStrictEqual(config.contextFiles, []);
		assert.strictEqual(config.autocommit, false);
	});

	it("respects PI_MEMORY_DIR override", () => {
		const config = buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: "/custom/mem" });
		assert.strictEqual(config.memoryDir, "/custom/mem");
		assert.strictEqual(config.memoryFile, "/custom/mem/MEMORY.md");
		assert.strictEqual(config.scratchpadFile, "/custom/mem/SCRATCHPAD.md");
		assert.strictEqual(config.notesDir, "/custom/mem/notes");
	});

	it("respects PI_DAILY_DIR override independently of memory dir", () => {
		const config = buildConfig({ HOME: "/home/x", PI_DAILY_DIR: "/other/daily" });
		assert.strictEqual(config.dailyDir, "/other/daily");
		assert.strictEqual(config.memoryDir, "/home/x/.pi/agent/memory");
		assert.strictEqual(config.sessionDir, "/home/x/.pi/agent/sessions");
	});

	it("respects PI_CODING_AGENT_DIR for memory and sessions defaults", () => {
		const config = buildConfig({ HOME: "/home/x", PI_CODING_AGENT_DIR: "/xdg/pi" });
		assert.strictEqual(config.memoryDir, "/xdg/pi/memory");
		assert.strictEqual(config.sessionDir, "/xdg/pi/sessions");
	});

	it("parses PI_CONTEXT_FILES as comma-separated list", () => {
		const config = buildConfig({ HOME: "/home/x", PI_CONTEXT_FILES: "SOUL.md, AGENTS.md, HEARTBEAT.md" });
		assert.deepStrictEqual(config.contextFiles, ["SOUL.md", "AGENTS.md", "HEARTBEAT.md"]);
	});

	it("handles empty PI_CONTEXT_FILES", () => {
		const config = buildConfig({ HOME: "/home/x", PI_CONTEXT_FILES: "" });
		assert.deepStrictEqual(config.contextFiles, []);
	});

	it("handles PI_CONTEXT_FILES with extra whitespace and trailing comma", () => {
		const config = buildConfig({ HOME: "/home/x", PI_CONTEXT_FILES: " A.md ,  B.md , " });
		assert.deepStrictEqual(config.contextFiles, ["A.md", "B.md"]);
	});

	it("enables autocommit with PI_AUTOCOMMIT=1", () => {
		const config = buildConfig({ HOME: "/home/x", PI_AUTOCOMMIT: "1" });
		assert.strictEqual(config.autocommit, true);
	});

	it("enables autocommit with PI_AUTOCOMMIT=true", () => {
		const config = buildConfig({ HOME: "/home/x", PI_AUTOCOMMIT: "true" });
		assert.strictEqual(config.autocommit, true);
	});

	it("does not enable autocommit with PI_AUTOCOMMIT=0", () => {
		const config = buildConfig({ HOME: "/home/x", PI_AUTOCOMMIT: "0" });
		assert.strictEqual(config.autocommit, false);
	});

	it("does not enable autocommit with PI_AUTOCOMMIT=yes", () => {
		const config = buildConfig({ HOME: "/home/x", PI_AUTOCOMMIT: "yes" });
		assert.strictEqual(config.autocommit, false);
	});

	it("falls back to ~ when HOME is undefined", () => {
		const config = buildConfig({});
		assert.strictEqual(config.memoryDir, "~/.pi/agent/memory");
		assert.strictEqual(config.sessionDir, "~/.pi/agent/sessions");
	});
});
