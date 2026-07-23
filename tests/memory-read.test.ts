import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { cleanup, makeConfig, makeTempDir, writeFile } from "./helpers.ts";
import { ensureDirs, resolveIndexedFile, readMemoryFile } from "../lib.ts";

let tmpDir: string;

function seedIndexedDirectory() {
	const config = makeConfig(tmpDir);
	ensureDirs(config);
	const dir = path.join(config.memoryDir, "activity", "2026-05-23");
	writeFile(path.join(dir, "INDEX.md"), `<!-- index 2026-05-23 -->
💬 Group: Founder Group — • **Alex Rivera** discussed high monthly LLM spend, with non-engineering workflows driving most cost. <!-- file:1613_chat_founder-group.md -->
💬 Group: Parent Chat — • **Morgan Lee** shared a family logistics incident involving a toddler and a stuck door. <!-- file:1722_chat_parent-chat.md -->
💬 Group: Product Dev Stream — • **Watchdog Alert** repeatedly flagged browser service memory pressure and high 5xx/min errors. <!-- file:2336_chat_product-dev-stream.md -->
💬 Group: Product Community — • **Pat Casey** reported issues connecting desktop messaging and asked about custom skill packages. <!-- file:1033_chat_product-community.md -->
`);
	writeFile(path.join(dir, "1613_chat_founder-group.md"), "# Founder Group\n\nAlex discussed LLM spend.");
	writeFile(path.join(dir, "1722_chat_parent-chat.md"), "# Parent Chat\n\nMorgan discussed the door incident.");
	writeFile(path.join(dir, "2336_chat_product-dev-stream.md"), "# Product Dev Stream\n\nWatchdog alerts.");
	writeFile(path.join(dir, "1033_chat_product-community.md"), "# Product Community\n\nDesktop messaging setup questions.");
	return config;
}

describe("memory_read indexed directory resolution", () => {
	beforeEach(() => { tmpDir = makeTempDir(); });
	afterEach(() => { cleanup(tmpDir); });

	it("reads exact indexed files unchanged", () => {
		const config = seedIndexedDirectory();
		const result = readMemoryFile(config, path.normalize("activity/2026-05-23/INDEX.md"));
		assert.match(result.text, /Founder Group/);
		assert.match(result.text, /1722_chat_parent-chat\.md/);
		assert.equal(result.details.filename, path.normalize("activity/2026-05-23/INDEX.md"));
	});

	it("resolves a title query through sibling INDEX.md", () => {
		const config = seedIndexedDirectory();
		const result = resolveIndexedFile(config, path.normalize("activity/2026-05-23"), "Parent Chat");
		assert.match(result.text, /Morgan discussed the door incident/);
		assert.equal(result.details.filename, path.normalize("activity/2026-05-23/1722_chat_parent-chat.md"));
	});

	it("resolves prefixed index titles without requiring the prefix", () => {
		const config = seedIndexedDirectory();
		const result = resolveIndexedFile(config, path.normalize("activity/2026-05-23"), "Founder Group");
		assert.match(result.text, /Alex discussed LLM spend/);
		assert.equal(result.details.filename, path.normalize("activity/2026-05-23/1613_chat_founder-group.md"));
	});

	it("self-heals hallucinated indexed file paths by consulting sibling INDEX.md", () => {
		const config = seedIndexedDirectory();
		const result = readMemoryFile(config, path.normalize("activity/2026-05-23/Parent Chat.md"));
		assert.match(result.text, /Morgan discussed the door incident/);
		assert.equal(result.details.filename, path.normalize("activity/2026-05-23/1722_chat_parent-chat.md"));
		assert.equal(result.details.resolvedFrom, "Parent Chat");
	});

	it("returns exact candidates for ambiguous indexed queries", () => {
		const config = seedIndexedDirectory();
		const result = resolveIndexedFile(config, path.normalize("activity/2026-05-23"), "Product");
		assert.match(result.text, /Multiple indexed entries matched "Product"/);
		assert.match(result.text, /activity(\/|\\)2026-05-23(\/|\\)2336_chat_product-dev-stream\.md/);
		assert.match(result.text, /activity(\/|\\)2026-05-23(\/|\\)1033_chat_product-community\.md/);
		assert.equal(result.details.reason, "ambiguous");
	});

	it("gives useful nearby-directory guidance when INDEX.md is missing", () => {
		const config = seedIndexedDirectory();
		writeFile(path.join(config.memoryDir, "activity", "2026-05-22", "INDEX.md"), "Older index");
		const result = resolveIndexedFile(config, path.normalize("activity/2026-05-21"), "Parent Chat");
		assert.match(result.text, /No INDEX\.md for activity(\/|\\)2026-05-21/);
		assert.match(result.text, /Indexed directories nearby: activity(\/|\\)2026-05-23(\/|\\)/);
		assert.match(result.text, /activity(\/|\\)2026-05-22(\/|\\)/);
	});

	it("gives the same guidance for hallucinated paths when INDEX.md is missing", () => {
		const config = seedIndexedDirectory();
		const result = readMemoryFile(config, path.normalize("activity/2026-05-21/Parent Chat.md"));
		assert.match(result.text, /No INDEX\.md for activity(\/||\\)2026-05-21/);
		assert.match(result.text, /Indexed directories nearby: activity(\/||\\)2026-05-23(\/||\\)/);
	});
});
