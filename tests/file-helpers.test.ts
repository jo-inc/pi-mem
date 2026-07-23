import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSafe, ensureDirs, safeResolvePath } from "../lib.ts";
import { makeTempDir, cleanup, makeConfig, writeFile } from "./helpers.ts";

let tmpDir: string;

beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

describe("readFileSafe", () => {
	it("reads an existing file", () => {
		const filePath = path.join(tmpDir, "test.md");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		assert.strictEqual(readFileSafe(filePath), "hello world");
	});

	it("returns null for non-existent file", () => {
		assert.strictEqual(readFileSafe(path.join(tmpDir, "nope.md")), null);
	});

	it("returns null for directory path", () => {
		assert.strictEqual(readFileSafe(tmpDir), null);
	});

	it("reads empty file as empty string", () => {
		const filePath = path.join(tmpDir, "empty.md");
		fs.writeFileSync(filePath, "", "utf-8");
		assert.strictEqual(readFileSafe(filePath), "");
	});

	it("reads file with unicode content", () => {
		const filePath = path.join(tmpDir, "unicode.md");
		fs.writeFileSync(filePath, "Hello \u2192 World \ud83d\ude80", "utf-8");
		assert.strictEqual(readFileSafe(filePath), "Hello \u2192 World \ud83d\ude80");
	});
});

describe("ensureDirs", () => {
	it("creates all directories", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		assert.ok(fs.existsSync(config.memoryDir));
		assert.ok(fs.existsSync(config.dailyDir));
		assert.ok(fs.existsSync(config.notesDir));
	});

	it("is idempotent — calling twice doesn't throw", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		ensureDirs(config);
		assert.ok(fs.existsSync(config.memoryDir));
	});

	it("doesn't destroy existing files in directories", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const testFile = path.join(config.memoryDir, "existing.md");
		fs.writeFileSync(testFile, "keep me", "utf-8");
		ensureDirs(config);
		assert.strictEqual(fs.readFileSync(testFile, "utf-8"), "keep me");
	});
});

describe("safeResolvePath", () => {
	it("allows simple filenames", () => {
		const result = safeResolvePath("/mem", "SOUL.md");
		assert.ok(result);
		assert.strictEqual(result.normalized, "SOUL.md");
		assert.strictEqual(result.resolved, path.join("/mem", "SOUL.md"));
	});

	it("allows subdirectory paths", () => {
		const result = safeResolvePath("/mem", "catchup/2026-04-26/file.md");
		assert.ok(result);
		assert.strictEqual(result.normalized, path.normalize("catchup/2026-04-26/file.md"));
		assert.strictEqual(result.resolved, path.join("/mem", "catchup/2026-04-26/file.md"));
	});

	it("blocks .. traversal", () => {
		assert.strictEqual(safeResolvePath("/mem", "../etc/passwd"), null);
	});

	it("blocks nested .. traversal", () => {
		assert.strictEqual(safeResolvePath("/mem", "foo/../../etc/passwd"), null);
	});

	it("blocks deep nested .. traversal", () => {
		assert.strictEqual(safeResolvePath("/mem", "catchup/2026/../../../etc/passwd"), null);
	});

	it("blocks absolute paths", () => {
		assert.strictEqual(safeResolvePath("/mem", "/etc/passwd"), null);
		assert.strictEqual(safeResolvePath("/mem", "\\etc\\passwd"), null);
	});

	it("blocks absolute win32 paths", () => {
		assert.strictEqual(safeResolvePath("/mem", "C:\\etc\\passwd"), null);
		assert.strictEqual(safeResolvePath("C:\\mem", "C:/etc/passwd"), null);
		assert.strictEqual(safeResolvePath("C:/mem", "Z:/etc/passwd"), null);
	});

	it("allows paths that resolve within memoryDir after normalization", () => {
		const result = safeResolvePath("/mem", "catchup/2026/../2026/file.md");
		assert.ok(result);
		assert.strictEqual(result.normalized, path.normalize("catchup/2026/file.md"));
	});
});
