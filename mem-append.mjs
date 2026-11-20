// Command adapter for the shared memory tool used by Claude Code.
import fs from "node:fs";
import path from "node:path";
import { appendStampedEntry, buildConfig, dailyPath, formatMemoryEntry, nowTimestamp, todayStr } from "./lib.ts";

const [target, sessionId] = process.argv.slice(2);
if (!sessionId || !["daily", "long_term"].includes(target)) {
	console.error("Usage: mem-append <daily|long_term> <session-id> (entry on stdin)");
	process.exit(1);
}
try {
	const config = buildConfig();
	const file = target === "daily" ? dailyPath(config.dailyDir, todayStr(config.timezone)) : config.memoryFile;
	const entry = formatMemoryEntry(fs.readFileSync(0, "utf8"), nowTimestamp(), sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	appendStampedEntry(file, entry);
	console.log("Appended to " + path.relative(config.memoryDir, file));
} catch (error) {
	console.error("mem-append:", error.message);
	process.exitCode = 1;
}
