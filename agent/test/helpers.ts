import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { TestContext } from "node:test";
import { LineBuffer } from "../src/transport.js";

/** A fresh temporary directory that is removed when the test finishes. */
export function tempDir(t: TestContext, prefix = "coderra-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Sets environment variables for one test and restores them afterwards. */
export function withEnv(t: TestContext, vars: Record<string, string | undefined>) {
	const before: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		before[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	t.after(() => {
		for (const [k, v] of Object.entries(before)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

/** Connects to the daemon's socket and collects parsed records. */
export async function dial(path: string) {
	const socket = net.connect(path);
	socket.setEncoding("utf8");
	const records: any[] = [];
	const lines = new LineBuffer();
	let ended = false;
	socket.on("data", (chunk: string) => {
		for (const l of lines.push(chunk)) records.push(JSON.parse(l));
	});
	socket.on("close", () => (ended = true));
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	const send = (record: object) => socket.write(`${JSON.stringify(record)}\n`);
	const until = async (test: () => boolean, ms = 2000) => {
		const t0 = Date.now();
		while (!test()) {
			if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(records.map((r) => r.type))}`);
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	return { socket, records, send, until, get ended() { return ended; } };
}
