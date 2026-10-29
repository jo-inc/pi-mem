import { describe, it } from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import {
	walkSessionAncestry,
	parseSessionHeader,
	formatAncestry,
	ANCESTRY_MAX_DEPTH,
	type SessionHeader,
} from "../lib.ts";
import { makeTempDir, cleanup, writeFile } from "./helpers.ts";

// Build an in-memory header lookup so the walker can be tested without disk.
function headerMap(entries: Record<string, SessionHeader | null>): (file: string) => SessionHeader | null {
	return (file: string) => (file in entries ? entries[file] : null);
}

describe("walkSessionAncestry", () => {
	it("returns a single node for a root session (no parentSession)", () => {
		const read = headerMap({
			"/s/current.jsonl": { id: "cur", timestamp: "2026-01-02T00:00:00Z" },
		});
		const { chain, truncatedAtDepth } = walkSessionAncestry("/s/current.jsonl", read);
		assert.strictEqual(chain.length, 1);
		assert.strictEqual(chain[0].depth, 0);
		assert.strictEqual(chain[0].sessionId, "cur");
		assert.strictEqual(chain[0].note, undefined);
		assert.strictEqual(truncatedAtDepth, undefined);
	});

	it("walks a fork chain newest-first up to the root", () => {
		const read = headerMap({
			"/s/c.jsonl": { id: "c", parentSession: "/s/b.jsonl" },
			"/s/b.jsonl": { id: "b", parentSession: "/s/a.jsonl" },
			"/s/a.jsonl": { id: "a" },
		});
		const { chain } = walkSessionAncestry("/s/c.jsonl", read);
		assert.deepStrictEqual(
			chain.map((n) => [n.depth, n.sessionId]),
			[[0, "c"], [1, "b"], [2, "a"]],
		);
	});

	it("stops and notes a cycle", () => {
		const read = headerMap({
			"/s/a.jsonl": { id: "a", parentSession: "/s/b.jsonl" },
			"/s/b.jsonl": { id: "b", parentSession: "/s/a.jsonl" },
		});
		const { chain } = walkSessionAncestry("/s/a.jsonl", read);
		const last = chain[chain.length - 1];
		assert.match(last.note ?? "", /cycle/);
		// a, b, then the cycle sentinel pointing back at a
		assert.strictEqual(chain.length, 3);
	});

	it("stops and notes a missing or unreadable parent", () => {
		const read = headerMap({
			"/s/a.jsonl": { id: "a", parentSession: "/s/gone.jsonl" },
			"/s/gone.jsonl": null,
		});
		const { chain } = walkSessionAncestry("/s/a.jsonl", read);
		const last = chain[chain.length - 1];
		assert.strictEqual(last.file, "/s/gone.jsonl");
		assert.match(last.note ?? "", /missing or header unreadable/);
	});

	it("caps a runaway chain at ANCESTRY_MAX_DEPTH", () => {
		// Each file points to the next: file-0 -> file-1 -> ... forever.
		const read = (file: string): SessionHeader => {
			const n = Number(file.replace(/\D/g, ""));
			return { id: `s${n}`, parentSession: `file-${n + 1}.jsonl` };
		};
		const { chain, truncatedAtDepth } = walkSessionAncestry("file-0.jsonl", read);
		assert.strictEqual(truncatedAtDepth, ANCESTRY_MAX_DEPTH);
		assert.strictEqual(chain.length, ANCESTRY_MAX_DEPTH);
	});
});

describe("parseSessionHeader", () => {
	it("parses the first line of a session JSONL file", () => {
		const dir = makeTempDir();
		const file = path.join(dir, "session.jsonl");
		writeFile(
			file,
			JSON.stringify({ type: "session", id: "abc", cwd: "/proj", parentSession: "/s/parent.jsonl" }) +
				"\n" +
				JSON.stringify({ type: "message", id: "m1" }) +
				"\n",
		);
		const header = parseSessionHeader(file);
		assert.strictEqual(header?.id, "abc");
		assert.strictEqual(header?.cwd, "/proj");
		assert.strictEqual(header?.parentSession, "/s/parent.jsonl");
		cleanup(dir);
	});

	it("returns null for a missing file", () => {
		assert.strictEqual(parseSessionHeader("/does/not/exist.jsonl"), null);
	});

	it("returns null for a malformed header line", () => {
		const dir = makeTempDir();
		const file = path.join(dir, "bad.jsonl");
		writeFile(file, "not json{{\n");
		assert.strictEqual(parseSessionHeader(file), null);
		cleanup(dir);
	});
});

describe("formatAncestry", () => {
	it("reports a root session plainly", () => {
		const text = formatAncestry({ chain: [{ file: "/s/a.jsonl", sessionId: "a", depth: 0 }] });
		assert.match(text, /root session/);
	});

	it("reports ancestor count for a chain", () => {
		const text = formatAncestry({
			chain: [
				{ file: "/s/c.jsonl", sessionId: "c", depth: 0 },
				{ file: "/s/b.jsonl", sessionId: "b", depth: 1 },
				{ file: "/s/a.jsonl", sessionId: "a", depth: 2 },
			],
		});
		assert.match(text, /2 ancestor thread/);
	});

	it("explains an ephemeral session with no file", () => {
		const text = formatAncestry({ chain: [] });
		assert.match(text, /ephemeral/);
	});

	it("appends the entry-lineage summary when provided", () => {
		const text = formatAncestry(
			{ chain: [{ file: "/s/a.jsonl", sessionId: "a", depth: 0 }] },
			{ count: 12, rootId: "r", leafId: "l" },
		);
		assert.match(text, /12 entries/);
	});
});
