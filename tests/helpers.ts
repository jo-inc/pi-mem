import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryConfig } from "../lib.ts";

export function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-test-"));
}

export function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

export function makeConfig(baseDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
	const memoryDir = path.join(baseDir, "memory");
	return {
		memoryDir,
		memoryFile: path.join(memoryDir, "MEMORY.md"),
		scratchpadFile: path.join(memoryDir, "SCRATCHPAD.md"),
		dailyDir: path.join(memoryDir, "daily"),
		notesDir: path.join(memoryDir, "notes"),
		contextFiles: [],
		searchDirs: [],
		autocommit: false,
		timezone: "UTC",
		contextMode: "bootstrap",
		...overrides,
	};
}

export function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}
