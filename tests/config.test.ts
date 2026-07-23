import { describe, it } from "node:test";
import assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import { buildConfig, resolveAgentDir, resolveHomeDir, resolveSessionsDir } from "../lib.ts";
import { makeTempDir, cleanup, writeFile } from "./helpers.ts";

describe("buildConfig", () => {
	it("uses defaults when no env vars set", () => {
		const config = buildConfig({ HOME: path.normalize("/home/testuser") });
		assert.strictEqual(config.memoryDir, path.normalize("/home/testuser/.pi/agent/memory"));
		assert.strictEqual(config.memoryFile, path.normalize("/home/testuser/.pi/agent/memory/MEMORY.md"));
		assert.strictEqual(config.scratchpadFile, path.normalize("/home/testuser/.pi/agent/memory/SCRATCHPAD.md"));
		assert.strictEqual(config.dailyDir, path.normalize("/home/testuser/.pi/agent/memory/daily"));
		assert.strictEqual(config.notesDir, path.normalize("/home/testuser/.pi/agent/memory/notes"));
		assert.deepStrictEqual(config.contextFiles, []);
		assert.strictEqual(config.autocommit, false);
		assert.strictEqual(config.timezone, "UTC");
	});

	it("respects PI_MEMORY_DIR override", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_MEMORY_DIR: path.normalize("/custom/mem") });
		assert.strictEqual(config.memoryDir, path.normalize("/custom/mem"));
		assert.strictEqual(config.memoryFile, path.normalize("/custom/mem/MEMORY.md"));
		assert.strictEqual(config.scratchpadFile, path.normalize("/custom/mem/SCRATCHPAD.md"));
		assert.strictEqual(config.notesDir, path.normalize("/custom/mem/notes"));
	});

	it("respects PI_DAILY_DIR override independently of memory dir", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_DAILY_DIR: path.normalize("/other/daily") });
		assert.strictEqual(config.dailyDir, path.normalize("/other/daily"));
		assert.strictEqual(config.memoryDir, path.normalize("/home/x/.pi/agent/memory"));
	});

	it("parses PI_CONTEXT_FILES as comma-separated list", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_CONTEXT_FILES: "SOUL.md, AGENTS.md, HEARTBEAT.md" });
		assert.deepStrictEqual(config.contextFiles, ["SOUL.md", "AGENTS.md", "HEARTBEAT.md"]);
	});

	it("handles empty PI_CONTEXT_FILES", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_CONTEXT_FILES: "" });
		assert.deepStrictEqual(config.contextFiles, []);
	});

	it("handles PI_CONTEXT_FILES with extra whitespace and trailing comma", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_CONTEXT_FILES: " A.md ,  B.md , " });
		assert.deepStrictEqual(config.contextFiles, ["A.md", "B.md"]);
	});

	it("enables autocommit with PI_AUTOCOMMIT=1", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_AUTOCOMMIT: "1" });
		assert.strictEqual(config.autocommit, true);
	});

	it("enables autocommit with PI_AUTOCOMMIT=true", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_AUTOCOMMIT: "true" });
		assert.strictEqual(config.autocommit, true);
	});

	it("does not enable autocommit with PI_AUTOCOMMIT=0", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_AUTOCOMMIT: "0" });
		assert.strictEqual(config.autocommit, false);
	});

	it("does not enable autocommit with PI_AUTOCOMMIT=yes", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_AUTOCOMMIT: "yes" });
		assert.strictEqual(config.autocommit, false);
	});

	it("parses PI_SEARCH_DIRS as comma-separated list", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_SEARCH_DIRS: "catchup, projects" });
		assert.deepStrictEqual(config.searchDirs, ["catchup", "projects"]);
	});

	it("uses PI_TIMEZONE before TZ", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), TZ: "UTC", PI_TIMEZONE: "America/Los_Angeles" });
		assert.strictEqual(config.timezone, "America/Los_Angeles");
	});

	it("falls back to TZ for timezone", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), TZ: "America/New_York" });
		assert.strictEqual(config.timezone, "America/New_York");
	});

	it("falls back to UTC for invalid timezone", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_TIMEZONE: "not/a-zone", TZ: "also-bad" });
		assert.strictEqual(config.timezone, "UTC");
	});

	it("defaults PI_SEARCH_DIRS to empty array", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x") });
		assert.deepStrictEqual(config.searchDirs, []);
	});

	it("handles PI_SEARCH_DIRS with extra whitespace and trailing comma", () => {
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_SEARCH_DIRS: " catchup ,  projects , " });
		assert.deepStrictEqual(config.searchDirs, ["catchup", "projects"]);
	});

	it("reads .pi-mem.json from memory dir", () => {
		const memDir = makeTempDir();
		writeFile(
			path.join(memDir, ".pi-mem.json"),
			JSON.stringify({
			searchDirs: ["catchup", "projects"],
			contextFiles: ["SOUL.md"],
			autocommit: true,
			}),
		);
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_MEMORY_DIR: memDir });
		assert.deepStrictEqual(config.searchDirs, ["catchup", "projects"]);
		assert.deepStrictEqual(config.contextFiles, ["SOUL.md"]);
		assert.strictEqual(config.autocommit, true);
		cleanup(memDir);
	});

	it("env vars override .pi-mem.json values", () => {
		const memDir = makeTempDir();
		writeFile(
			path.join(memDir, ".pi-mem.json"),
			JSON.stringify({
			searchDirs: ["catchup"],
			contextFiles: ["SOUL.md"],
			autocommit: true,
			}),
		);
		const config = buildConfig({
			HOME: path.normalize("/home/x"),
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
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_MEMORY_DIR: memDir });
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
		const config = buildConfig({ HOME: path.normalize("/home/x"), PI_MEMORY_DIR: memDir });
		assert.deepStrictEqual(config.searchDirs, []);
		assert.deepStrictEqual(config.contextFiles, []);
		assert.strictEqual(config.autocommit, false);
		cleanup(memDir);
	});

	it("uses the supplied platform fallback when home variables are absent", () => {
		assert.strictEqual(resolveHomeDir({}, path.normalize("/fallback/home")), path.normalize("/fallback/home"));
		assert.strictEqual(resolveAgentDir({}, path.normalize("/fallback/home")), path.normalize("/fallback/home/.pi/agent"));
	});

	it("uses os.homedir() when fallback arguments are not provided", () => {
		assert.strictEqual(resolveHomeDir({}), os.homedir());
		assert.strictEqual(resolveAgentDir({}), path.join(os.homedir(), ".pi", "agent"));
	});

	it("uses os.homedir() when fallback is null or undefined", () => {
		assert.strictEqual(resolveHomeDir({}, null as unknown as string), os.homedir());
		assert.strictEqual(resolveAgentDir({}, null as unknown as string), path.join(os.homedir(), ".pi", "agent"));
		assert.strictEqual(resolveSessionsDir({}, null as unknown as string), path.join(os.homedir(), ".pi", "agent", "sessions"));
	});

	it("supports Windows USERPROFILE", () => {
		assert.strictEqual(resolveHomeDir({ USERPROFILE: "C:\\Users\\test" }, "/fallback"), path.normalize("C:\\Users\\test"));
	});

	it("supports Windows HOMEDRIVE and HOMEPATH", () => {
		assert.strictEqual(resolveHomeDir({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\test" }, "/fallback"), path.normalize("C:\\Users\\test"));
	});

	it("respects PI_CODING_AGENT_DIR for memory and sessions", () => {
		const env = { HOME: path.normalize("/home/x"), PI_CODING_AGENT_DIR: path.normalize("/custom/agent") };
		assert.strictEqual(buildConfig(env).memoryDir, path.normalize("/custom/agent/memory"));
		assert.strictEqual(resolveSessionsDir(env), path.normalize("/custom/agent/sessions"));
	});
});
