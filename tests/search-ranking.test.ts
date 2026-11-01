import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { searchMemory, ensureDirs } from "../lib.ts";
import { makeTempDir, cleanup, makeConfig } from "./helpers.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

/**
 * 2026-11-01 canary on jo-machine-prod-1: "which crime shows did I want to
 * watch?" returned SOUL.md and daily-log lines; the crime-shows note never made
 * the top 8. Common query words ("no", "only", "which", "want", "name") passed
 * the stopword list and matched as substrings ("no" in "know", "name" in
 * "filename") across 154 daily logs, which are scanned before notes/. Every
 * such line tied with or beat the one real hit, and ties went to scan order.
 */
describe("searchMemory ranking on a realistic archive", () => {
	function seed(): ReturnType<typeof makeConfig> {
		const config = makeConfig(tmpDir, { searchDirs: ["catchup"] });
		ensureDirs(config);
		// 60 daily logs of engineering chatter: dense in "no", "only", "which",
		// "name", "want", "tools", "memory", "show(ed)", "know", "filename".
		const noise = [
			"- No regressions today; only the flaky test failed, which we know about.",
			"- Renamed the filename pattern so tools pick up memory snapshots.",
			"- I want to show the team the new dashboard; name TBD.",
			"- Showed the onboarding flow; only one blocker, which is the OAuth scope.",
		];
		for (let d = 1; d <= 60; d++) {
			const date = `2026-0${1 + (d % 8)}-${String(1 + (d % 27)).padStart(2, "0")}`;
			fs.writeFileSync(path.join(config.dailyDir, `${date}-${d}.md`), Array.from({ length: 40 }, (_, i) => noise[i % noise.length]).join("\n"));
		}
		fs.writeFileSync(path.join(config.notesDir, "crime-shows-to-watch.md"), [
			"<!-- 2026-10-18 --> # 20 Crime Shows to Binge-Watch",
			"From The Atlantic (April 2020)",
			"- **Luther** (Hulu) — Idris Elba stalking through London.",
			"- **Happy Valley** — Sarah Lancashire.",
		].join("\n"));
		fs.writeFileSync(path.join(config.notesDir, "dog-project.md"), "# Dog project\n- Build a GPS collar that texts me when Biscuit leaves the yard.\n");
		return config;
	}

	it("ranks the crime-shows note at the top for the exact production query", () => {
		const config = seed();
		const r = searchMemory(config, "From memory only, no tools: which crime shows did I want to watch? Name a couple.", 8);
		assert.ok(r.fileMatches.includes("notes/crime-shows-to-watch.md"), `fileMatches: ${JSON.stringify(r.fileMatches)}`);
		assert.strictEqual(r.lineResults[0]?.file, "notes/crime-shows-to-watch.md", `top hit: ${JSON.stringify(r.lineResults[0])}`);
		const fromNote = r.lineResults.filter(h => h.file === "notes/crime-shows-to-watch.md").length;
		assert.ok(fromNote >= 2, `expected the note's lines to dominate the top 8, got ${fromNote}: ${JSON.stringify(r.lineResults.map(h => h.file))}`);
	});

	it("matches whole words: 'no' does not hit 'know', 'name' does not hit 'filename'", () => {
		const config = seed();
		fs.writeFileSync(path.join(config.notesDir, "probe.md"), "- know the filename\n- no name here\n");
		const r = searchMemory(config, "no name", 50);
		const probe = r.lineResults.filter(h => h.file === "notes/probe.md").map(h => h.line);
		assert.deepStrictEqual(probe, [2], `matched lines in probe: ${JSON.stringify(probe)}`);
	});

	it("rare terms outweigh common ones: a line matching only 'crime' beats a line matching 'want' and 'show'", () => {
		const config = seed();
		const r = searchMemory(config, "crime show I want", 8);
		assert.strictEqual(r.lineResults[0]?.file, "notes/crime-shows-to-watch.md", JSON.stringify(r.lineResults.slice(0, 3)));
	});

	it("finds the dog project by its filename even when the body shares no query word", () => {
		const config = seed();
		const r = searchMemory(config, "tell me about my dog project", 8);
		assert.ok(r.fileMatches.includes("notes/dog-project.md"));
		assert.strictEqual(r.lineResults[0]?.file, "notes/dog-project.md", JSON.stringify(r.lineResults.slice(0, 3)));
	});
});
