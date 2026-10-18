// A tiny stand-in for the host that serves only the fs_* commands over JSONL on stdin/stdout, using the same code
// (runFsCommand) the real host uses. The Flutter tests start it to check that the Dart side and the Node side agree on
// the protocol: base64 chunks, millisecond mtimes, error codes. Built by `npm test` into .test-out/harness/.
//
//   node fs_server.mjs '<roots json>' '<limits json>'
//   roots:  [{"path": "/abs/dir", "readOnly": false}, ...]
//   limits: optional overrides for the Fs limits (chunk, maxWrite, ...)
import { createInterface } from "node:readline";
import { errorCode, Fs, runFsCommand } from "../../src/fs.js";

const roots = JSON.parse(process.argv[2] ?? "[]");
const limits = JSON.parse(process.argv[3] ?? "{}");
const fs = new Fs(roots, limits);

const reply = (record: object) => process.stdout.write(`${JSON.stringify(record)}\n`);
const running = new Set<Promise<void>>();

createInterface({ input: process.stdin })
	.on("line", (line) => {
		if (!line.trim()) return;
		const job = (async () => {
			let cmd: Record<string, any>;
			try {
				cmd = JSON.parse(line);
			} catch (e) {
				reply({ type: "response", ok: false, error: `Bad JSON: ${(e as Error).message}` });
				return;
			}
			try {
				reply({ type: "response", id: cmd.id, ok: true, data: await runFsCommand(fs, cmd) });
			} catch (e) {
				reply({ type: "response", id: cmd.id, ok: false, error: String((e as Error)?.message ?? e), code: errorCode(e) });
			}
		})();
		running.add(job);
		void job.finally(() => running.delete(job));
	})
	.on("close", () => {
		void Promise.all(running).then(() => process.exit(0));
	});
