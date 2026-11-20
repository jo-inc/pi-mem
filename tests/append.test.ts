import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, cleanup } from "./helpers.ts";
import { appendStampedEntry } from "../lib.ts";

describe("appendStampedEntry", () => {
	it("writes the first entry without a separator and appends later ones after a blank line", () => {
		const dir = makeTempDir();
		try {
			const file = path.join(dir, "log.md");
			appendStampedEntry(file, "first");
			assert.strictEqual(fs.readFileSync(file, "utf-8"), "first");
			appendStampedEntry(file, "second");
			assert.strictEqual(fs.readFileSync(file, "utf-8"), "first\n\nsecond");
			fs.writeFileSync(file, "  \n");
			appendStampedEntry(file, "fresh");
			assert.strictEqual(fs.readFileSync(file, "utf-8"), "  \n\n\nfresh", "an existing blank file is appended to, never truncated");
		} finally {
			cleanup(dir);
		}
	});
});

describe("appendStampedEntry under concurrency (regression)", () => {
	it("never truncates an existing empty file", () => {
		const dir = makeTempDir();
		try {
			const file = path.join(dir, "log.md");
			fs.writeFileSync(file, "");
			appendStampedEntry(file, "A");
			appendStampedEntry(file, "B");
			assert.deepStrictEqual(fs.readFileSync(file, "utf-8").split("\n\n").filter(Boolean), ["A", "B"]);
		} finally {
			cleanup(dir);
		}
	});

	it("keeps both entries when two processes make the first append at the same time", async () => {
		const dir = makeTempDir();
		try {
			const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib.ts");
			const script = path.join(dir, "writer.ts");
			fs.writeFileSync(script, [
				`import { appendStampedEntry } from ${JSON.stringify(lib)};`,
				"const [dir, tag] = process.argv.slice(2);",
				"for (let i = 0; i < 300; i++) appendStampedEntry(`${dir}/f${i}.md`, `<!-- 2026-11-19 00:00:00 [${tag}] -->\\nentry ${tag}`);",
			].join("\n"));
			const run = (tag: string) => new Promise<number>((resolve, reject) => {
				const child = spawn(process.execPath, [...process.execArgv.filter(a => !a.startsWith("--test")), script, dir, tag], { stdio: ["ignore", "ignore", "inherit"] });
				child.on("error", reject);
				child.on("exit", code => resolve(code ?? 1));
			});
			const codes = await Promise.all([run("aaaa1111"), run("bbbb2222")]);
			assert.deepStrictEqual(codes, [0, 0]);
			for (let i = 0; i < 300; i++) {
				const entries = fs.readFileSync(path.join(dir, `f${i}.md`), "utf-8").split("\n\n").sort();
				assert.deepStrictEqual(entries, [
					"<!-- 2026-11-19 00:00:00 [aaaa1111] -->\nentry aaaa1111",
					"<!-- 2026-11-19 00:00:00 [bbbb2222] -->\nentry bbbb2222",
				], `file f${i}.md`);
			}
		} finally {
			cleanup(dir);
		}
	});
});
