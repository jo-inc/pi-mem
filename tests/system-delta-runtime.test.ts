import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { todayStr } from "../lib.ts";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { makeTempDir, cleanup } from "./helpers.ts";

test("Pi delivers an external edit once alongside the session's own memory_write result", async (t) => {
	const root = makeTempDir();
	const saved = { ...process.env };
	t.after(() => {
		process.env = saved;
		cleanup(root);
	});
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_")) delete process.env[key];
	}
	const memory = path.join(root, "memory");
	fs.mkdirSync(memory);
	process.env.PI_MEMORY_DIR = memory;
	process.env.PI_MEMORY_CONTEXT_MODE = "system-delta";
	process.env.PI_MEMORY_RECALL = "0";
	fs.writeFileSync(path.join(memory, ".pi-mem.json"), '{"autocommit":false}');
	const extension = (await import("../index.ts")).default;
	const faux = fauxProvider();
	const requestMessages: string[] = [];
	const own = "The session wrote this entry.";
	const external = "A different session wrote this entry.";
	faux.setResponses([
		() => {
			fs.writeFileSync(path.join(memory, "MEMORY.md"), external);
			return fauxAssistantMessage(fauxToolCall("memory_write", { target: "daily", content: own }), { stopReason: "toolUse" });
		},
		(context) => {
			requestMessages.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("Done.");
		},
	]);
	const agentDir = path.join(root, "agent");
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, extensionFactories: [extension, pi => pi.registerProvider(faux.provider)],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root, agentDir, resourceLoader, model: faux.getModel(), tools: ["memory_write"],
		sessionManager: SessionManager.inMemory(root),
	});
	try {
		await session.bindExtensions({});
		await session.prompt("Record a daily entry.");
		assert.equal(faux.state.callCount, 2);
		assert.equal(requestMessages[0].split(external).length - 1, 1);
		assert.equal(requestMessages[0].split(own).length - 1, 1);
		assert.match(requestMessages[0], /Appended to daily/);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("two Pi sessions receive each other's edit and deletion during a shared daily log review", async t => {
	const root = makeTempDir();
	const saved = { ...process.env };
	t.after(() => { process.env = saved; cleanup(root); });
	for (const key of Object.keys(process.env)) if (key.startsWith("PI_")) delete process.env[key];
	const memory = path.join(root, "memory");
	process.env.PI_MEMORY_DIR = memory;
	process.env.PI_MEMORY_CONTEXT_MODE = "system-delta";
	process.env.PI_MEMORY_RECALL = "0";
	process.env.PI_TIMEZONE = "UTC";
	const cli = fileURLToPath(new URL("../mem-append.mjs", import.meta.url));
	for (const [sid, content] of [["claude-session", "Meeting at noon"], ["marlow-session", "Dummy entry"]]) {
		execFileSync(process.execPath, [cli, "daily", sid], { input: content + "\n\n", env: { ...process.env } });
	}
	const file = path.join(memory, "daily", todayStr("UTC") + ".md");
	const initial = fs.readFileSync(file, "utf8");
	assert.match(initial, /\[claude-s\] -->\nMeeting at noon\n\n<!-- [^\n]+ \[marlow-s\] -->\nDummy entry$/);
	const dummy = initial.slice(initial.indexOf("\n\n"));
	const extension = (await import("../index.ts")).default;

	async function start(name: string) {
		const faux = fauxProvider({ provider: name });
		const agentDir = path.join(root, name);
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, extensionFactories: [extension, pi => pi.registerProvider(faux.provider)],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root, agentDir, resourceLoader, model: faux.getModel(), tools: ["edit"],
			sessionManager: SessionManager.inMemory(root),
		});
		await session.bindExtensions({});
		return { session, faux };
	}
	const a = await start("editor-a");
	const b = await start("editor-b");
	const updates = (session: typeof a.session) => session.sessionManager.getBranch()
		.filter(entry => entry.type === "custom_message" && entry.customType === "pi-mem-delta" && entry.details?.kind === "update")
		.map(entry => entry.content);
	const edit = (oldText: string, newText: string) => fauxAssistantMessage(
		fauxToolCall("edit", { path: file, edits: [{ oldText, newText }] }), { stopReason: "toolUse" });
	try {
		b.faux.setResponses([edit("Meeting at noon", "Meeting at two"), fauxAssistantMessage("Updated."), fauxAssistantMessage("Checked.")]);
		a.faux.setResponses([
			async () => {
				await b.session.prompt("Amend the meeting time.");
				return edit(dummy, "");
			},
			fauxAssistantMessage("Removed."),
		]);
		await a.session.prompt("Delete the dummy entry.");
		assert.equal(updates(b.session).length, 0);
		assert.equal(updates(a.session).length, 1);
		assert.match(updates(a.session)[0], /Updated entry[^\n]+\nMeeting at two/);
		assert.doesNotMatch(updates(a.session)[0], /Dummy entry|Removed entry/);
		await b.session.prompt("Check for further changes.");
		assert.equal(updates(b.session).length, 1);
		assert.match(updates(b.session)[0], /Removed entry[^\n]+Dummy entry/);
		assert.doesNotMatch(updates(b.session)[0], /Meeting at two|Updated entry/);
		assert.match(fs.readFileSync(file, "utf8"), /Meeting at two$/);
	} finally {
		for (const { session } of [b, a]) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	}
});

test("overflow retry receives memory written during compaction before its first provider call", async t => {
	const root = makeTempDir();
	const memory = path.join(root, "memory");
	const agentDir = path.join(root, "agent");
	const saved = { ...process.env };
	t.after(() => { process.env = saved; cleanup(root); });
	for (const key of Object.keys(process.env)) if (key.startsWith("PI_")) delete process.env[key];
	Object.assign(process.env, { PI_MEMORY_DIR: memory, PI_MEMORY_CONTEXT_MODE: "system-delta", PI_TIMEZONE: "UTC" });
	fs.mkdirSync(path.join(memory, "daily"), { recursive: true });
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 32 } }));
	const fresh = "New daily entry written during overflow recovery.";
	const faux = fauxProvider();
	const extension = (await import("../index.ts")).default;
	let compacted = false;
	let retryInput = "";
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, extensionFactories: [extension, pi => {
			pi.registerProvider(faux.provider);
			pi.on("session_before_compact", event => {
				if (event.reason !== "overflow" || !event.willRetry) return;
				compacted = true;
				fs.writeFileSync(path.join(memory, "daily", todayStr("UTC") + ".md"), fresh);
				return { compaction: {
					summary: "Prior conversation.", firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				} };
			});
		}],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root, agentDir, resourceLoader, model: faux.getModel(), noTools: "all", sessionManager: SessionManager.inMemory(root),
	});
	try {
		await session.bindExtensions({});
		faux.setResponses([
			fauxAssistantMessage("First answer."),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			context => { retryInput = JSON.stringify(context.messages); return fauxAssistantMessage("Recovered."); },
		]);
		await session.prompt("Initial conversation. ".repeat(300));
		await session.prompt("Continue.");
		await session.agent.waitForIdle();
		assert.ok(compacted, "Pi entered its overflow retry path");
		assert.equal(faux.state.callCount, 3);
		assert.ok(retryInput.includes(fresh), "first retry includes the fresh snapshot");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
