import { describe, it } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildConfig, resolveAgentDir, resolveHomeDir, resolveSessionsDir } from "../lib.ts";
import { makeTempDir, cleanup, writeFile } from "./helpers.ts";

describe("buildConfig", () => {
	it("uses defaults when no env vars set", () => {
		const config = buildConfig({ HOME: "/home/testuser" });
		assert.strictEqual(config.memoryDir, "/home/testuser/.pi/agent/memory");
		assert.strictEqual(config.memoryFile, "/home/testuser/.pi/agent/memory/MEMORY.md");
		assert.strictEqual(config.scratchpadFile, "/home/testuser/.pi/agent/memory/SCRATCHPAD.md");
		assert.strictEqual(config.dailyDir, "/home/testuser/.pi/agent/memory/daily");
		assert.strictEqual(config.notesDir, "/home/testuser/.pi/agent/memory/notes");
		assert.deepStrictEqual(config.contextFiles, []);
		assert.strictEqual(config.autocommit, false);
		assert.strictEqual(config.timezone, "UTC");
		// System mode is the default for every user, including a config file that
		// predates the field: MEMORY.md lives in the cached system prompt and a
		// bounded retrieval message is added per turn. Bootstrap's per-turn full
		// recall scanned the whole archive on every prompt and killed a 200 MB SDK
		// wrapper on a machine with a large catchup folder (2026-11-01).
		assert.strictEqual(config.contextMode, "system");
		assert.strictEqual(config.ancestry, false);
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
	});

	it("supports full and off context modes", () => {
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_MEMORY_CONTEXT_MODE: "full" }).contextMode, "full");
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_MEMORY_CONTEXT_MODE: "off" }).contextMode, "off");
	});

	it("supports system context mode", () => {
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_MEMORY_CONTEXT_MODE: "system" }).contextMode, "system");
	});

	it("falls back to system for an invalid context mode", () => {
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_MEMORY_CONTEXT_MODE: "invalid" }).contextMode, "system");
	});

	it("a config file without contextMode (every existing machine) gets system mode; bootstrap stays available by explicit request", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimem-cfg-"));
		fs.writeFileSync(path.join(dir, ".pi-mem.json"), JSON.stringify({ searchDirs: ["catchup"], autocommit: false }));
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: dir }).contextMode, "system");
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: dir, PI_MEMORY_CONTEXT_MODE: "bootstrap" }).contextMode, "bootstrap");
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

	it("enables ancestry with PI_ANCESTRY=1", () => {
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_ANCESTRY: "1" }).ancestry, true);
	});

	it("enables ancestry with PI_ANCESTRY=true", () => {
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_ANCESTRY: "true" }).ancestry, true);
	});

	it("does not enable ancestry with PI_ANCESTRY=0", () => {
		assert.strictEqual(buildConfig({ HOME: "/home/x", PI_ANCESTRY: "0" }).ancestry, false);
	});

	it("parses PI_SEARCH_DIRS as comma-separated list", () => {
		const config = buildConfig({ HOME: "/home/x", PI_SEARCH_DIRS: "catchup, projects" });
		assert.deepStrictEqual(config.searchDirs, ["catchup", "projects"]);
	});

	it("uses PI_TIMEZONE before TZ", () => {
		const config = buildConfig({ HOME: "/home/x", TZ: "UTC", PI_TIMEZONE: "America/Los_Angeles" });
		assert.strictEqual(config.timezone, "America/Los_Angeles");
	});

	it("falls back to TZ for timezone", () => {
		const config = buildConfig({ HOME: "/home/x", TZ: "America/New_York" });
		assert.strictEqual(config.timezone, "America/New_York");
	});

	it("falls back to UTC for invalid timezone", () => {
		const config = buildConfig({ HOME: "/home/x", PI_TIMEZONE: "not/a-zone", TZ: "also-bad" });
		assert.strictEqual(config.timezone, "UTC");
	});

	it("defaults PI_SEARCH_DIRS to empty array", () => {
		const config = buildConfig({ HOME: "/home/x" });
		assert.deepStrictEqual(config.searchDirs, []);
	});

	it("handles PI_SEARCH_DIRS with extra whitespace and trailing comma", () => {
		const config = buildConfig({ HOME: "/home/x", PI_SEARCH_DIRS: " catchup ,  projects , " });
		assert.deepStrictEqual(config.searchDirs, ["catchup", "projects"]);
	});

	it("reads .pi-mem.json from memory dir", () => {
		const memDir = makeTempDir();
		writeFile(path.join(memDir, ".pi-mem.json"), JSON.stringify({
			searchDirs: ["catchup", "projects"],
			contextFiles: ["SOUL.md"],
			autocommit: true,
			contextMode: "full",
		}));
		const config = buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: memDir });
		assert.deepStrictEqual(config.searchDirs, ["catchup", "projects"]);
		assert.deepStrictEqual(config.contextFiles, ["SOUL.md"]);
		assert.strictEqual(config.autocommit, true);
		assert.strictEqual(config.contextMode, "full");
		cleanup(memDir);
	});

	it("reads ancestry flag from .pi-mem.json", () => {
		const memDir = makeTempDir();
		writeFile(path.join(memDir, ".pi-mem.json"), JSON.stringify({ ancestry: true }));
		const config = buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: memDir });
		assert.strictEqual(config.ancestry, true);
		cleanup(memDir);
	});

	it("PI_ANCESTRY overrides .pi-mem.json ancestry", () => {
		const memDir = makeTempDir();
		writeFile(path.join(memDir, ".pi-mem.json"), JSON.stringify({ ancestry: true }));
		const config = buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: memDir, PI_ANCESTRY: "0" });
		assert.strictEqual(config.ancestry, false);
		cleanup(memDir);
	});

	it("env vars override .pi-mem.json values", () => {
		const memDir = makeTempDir();
		writeFile(path.join(memDir, ".pi-mem.json"), JSON.stringify({
			searchDirs: ["catchup"],
			contextFiles: ["SOUL.md"],
			autocommit: true,
		}));
		const config = buildConfig({
			HOME: "/home/x",
			PI_MEMORY_DIR: memDir,
			PI_SEARCH_DIRS: "projects,other",
			PI_CONTEXT_FILES: "AGENTS.md",
			PI_AUTOCOMMIT: "0",
		});
		assert.deepStrictEqual(config.searchDirs, ["projects", "other"]);
		assert.deepStrictEqual(config.contextFiles, ["AGENTS.md"]);
		assert.strictEqual(config.autocommit, false);
		cleanup(memDir);
	});

	it("ignores malformed .pi-mem.json", () => {
		const memDir = makeTempDir();
		writeFile(path.join(memDir, ".pi-mem.json"), "not json{{");
		const config = buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: memDir });
		assert.deepStrictEqual(config.searchDirs, []);
		assert.deepStrictEqual(config.contextFiles, []);
		cleanup(memDir);
	});

	it("ignores .pi-mem.json with wrong types", () => {
		const memDir = makeTempDir();
		writeFile(path.join(memDir, ".pi-mem.json"), JSON.stringify({
			searchDirs: "not-an-array",
			contextFiles: 42,
			autocommit: "yes",
		}));
		const config = buildConfig({ HOME: "/home/x", PI_MEMORY_DIR: memDir });
		assert.deepStrictEqual(config.searchDirs, []);
		assert.deepStrictEqual(config.contextFiles, []);
		assert.strictEqual(config.autocommit, false);
		cleanup(memDir);
	});

	it("uses the supplied platform fallback when home variables are absent", () => {
		assert.strictEqual(resolveHomeDir({}, "/fallback/home"), "/fallback/home");
		assert.strictEqual(resolveAgentDir({}, "/fallback/home"), "/fallback/home/.pi/agent");
	});

	it("supports Windows USERPROFILE", () => {
		assert.strictEqual(resolveHomeDir({ USERPROFILE: "C:\\Users\\test" }, "/fallback"), "C:\\Users\\test");
	});

	it("supports Windows HOMEDRIVE and HOMEPATH", () => {
		assert.strictEqual(resolveHomeDir({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\test" }, "/fallback"), "C:\\Users\\test");
	});

	it("respects PI_CODING_AGENT_DIR for memory and sessions", () => {
		const env = { HOME: "/home/x", PI_CODING_AGENT_DIR: "/custom/agent" };
		assert.strictEqual(buildConfig(env).memoryDir, "/custom/agent/memory");
		assert.strictEqual(resolveSessionsDir(env), "/custom/agent/sessions");
	});
});
