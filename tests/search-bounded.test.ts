import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { searchMemory, ensureDirs, SEARCH_MAX_QUERY_TERMS } from "../lib.ts";
import { makeTempDir, cleanup, makeConfig } from "./helpers.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

/**
 * 2026-11-01 canary on jo-machine-prod-1: the new bootstrap recall ran
 * searchMemory on every prompt. That machine's .pi-mem.json lists "catchup" in
 * searchDirs, and /data/me/catchup holds 183 day folders with thousands of
 * files. The search read every file fully and kept one hit object for every
 * matching line in the whole tree before truncating to 8, and the SDK wrapper
 * (200 MB heap) died with "JavaScript heap out of memory" ~8s into the turn.
 *
 * A memory search must stay bounded no matter how large the archive is.
 */
describe("searchMemory stays bounded on a large catchup archive", () => {
	it("returns quickly with bounded memory on a 200-day, 20k-file tree where every line matches", () => {
		const config = makeConfig(tmpDir, { searchDirs: ["catchup"] });
		ensureDirs(config);
		const root = path.join(config.memoryDir, "catchup");
		// 200 days x 100 files x 40 lines, every line contains the query term.
		const line = "lunch with the team about the quarterly plan and the lunch budget\n";
		const body = line.repeat(40);
		for (let d = 0; d < 200; d++) {
			const day = path.join(root, `2026-${String(1 + (d % 12)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}-${d}`);
			fs.mkdirSync(day, { recursive: true });
			for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(day, `${String(f).padStart(4, "0")}_chat_lunch-${f}.md`), body);
		}

		const before = process.memoryUsage().heapUsed;
		const started = Date.now();
		const result = searchMemory(config, "lunch", 8);
		const elapsedMs = Date.now() - started;
		const grewBytes = process.memoryUsage().heapUsed - before;

		assert.equal(result.lineResults.length, 8);
		assert.ok(elapsedMs < 4000, `search took ${elapsedMs}ms`);
		// 800k matching lines existed; the search must not have materialised them.
		assert.ok(grewBytes < 40 * 1024 * 1024, `heap grew ${Math.round(grewBytes / 1024 / 1024)}MB during search`);
		assert.ok(result.fileMatches.length <= 50, `fileMatches should be capped, got ${result.fileMatches.length}`);
	});

	it("bounds the term count so a prompt-sized query cannot pin the main thread", () => {
		const config = makeConfig(tmpDir, { searchDirs: ["catchup"] });
		ensureDirs(config);
		const root = path.join(config.memoryDir, "catchup", "2026-11-01");
		fs.mkdirSync(root, { recursive: true });
		const body = Array.from({ length: 400 }, (_, i) => `note line ${i} about project alpha and the budget review\n`).join("");
		for (let f = 0; f < 400; f++) fs.writeFileSync(path.join(root, `${String(f).padStart(4, "0")}_chat_x-${f}.md`), body);

		// ~20k distinct words, like a cron prompt carrying a day of catchup content.
		const query = Array.from({ length: 20000 }, (_, i) => `word${i}xq`).join(" ") + " budget";
		const started = Date.now();
		const result = searchMemory(config, query, 8);
		const elapsedMs = Date.now() - started;
		assert.ok(elapsedMs < 4000, `search took ${elapsedMs}ms`);
		assert.ok(SEARCH_MAX_QUERY_TERMS <= 32, "term mask is a 32-bit integer");
		// The query is truncated after SEARCH_MAX_QUERY_TERMS tokens, so the
		// trailing real word is not searched; that is the accepted trade-off.
		assert.equal(result.lineResults.length, 0);
	});
});
