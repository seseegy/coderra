/**
 * Patched versions of pi's built-in file tools.
 *
 * Registered through customTools under the same names, which makes them
 * replace the built-ins in the session's tool registry (custom definitions
 * win over built-in ones). Each patch delegates to the real pi tool and only
 * smooths the rough edges from on-device testing (agent feedback, 2026-10-17):
 *
 * - read: a missing file or a directory gets a friendly message instead of a
 *   raw ENOENT; binary files are reported as binary instead of being dumped
 *   as mojibake; image results gain the file's dimensions and size.
 * - write: permission errors explain which locations are writable.
 * - edit: a non-unique oldText error gains the line numbers of the matches.
 * - grep / find: when the result is cut by the limit, the note also reports
 *   the total number of matches ("Showing 10 of 30 matches"), counted with a
 *   second, high-limit pass that runs only in that case.
 *
 * bash is deliberately not patched: its shell comes from the app's settings
 * (Android shell or the Linux container), which only the session itself can
 * construct faithfully. Its quirks are documented in the AGENTS template
 * instead (see ensureAgentsFile in host.ts).
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

function resolveIn(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** First bytes of a file, for sniffing; null when it cannot be read. */
function headBytes(abs: string, max = 8192): Buffer | null {
	let fd: number;
	try {
		fd = openSync(abs, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.alloc(max);
		const n = readSync(fd, buf, 0, max, 0);
		return buf.subarray(0, n);
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

function hasImageMagic(buf: Buffer): boolean {
	if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return true; // PNG
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
	if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") return true; // GIF
	if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return true; // WebP
	return false;
}

function looksBinary(buf: Buffer): boolean {
	if (buf.includes(0)) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf);
		return false;
	} catch {
		return true;
	}
}

/** Pixel dimensions of a PNG, GIF, WebP or JPEG buffer; null when unknown. */
function imageDimensions(buf: Buffer): { w: number; h: number } | null {
	if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
		return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG IHDR
	}
	if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
		return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }; // GIF header
	}
	if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
		const kind = buf.toString("ascii", 12, 16);
		if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
		if (kind === "VP8L") {
			const b = buf.readUInt32LE(21);
			return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
		}
		if (kind === "VP8 " && buf.length > 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
			return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
		}
		return null;
	}
	if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		// JPEG: walk the marker segments until a start-of-frame marker.
		let i = 2;
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = buf[i + 1];
			if (marker === 0xc0 || marker === 0xc2) {
				return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
			}
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
				i += 2;
				continue;
			}
			const len = buf.readUInt16BE(i + 2);
			if (len < 2) break;
			i += 2 + len;
		}
	}
	return null;
}

function patchedRead(cwd: string, autoResizeImages: boolean) {
	const base = createReadToolDefinition(cwd, { autoResizeImages });
	return {
		...base,
		execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
			const abs = resolveIn(cwd, params.path as string);
			try {
				if (!existsSync(abs)) {
					return text(
						`File not found: ${params.path}\nPaths are relative to the workspace (${cwd}). Check the name, or locate the file with ls/find first.`,
					);
				}
				if (statSync(abs).isDirectory()) {
					return text(`"${params.path}" is a directory, not a file. Use ls to list its contents.`);
				}
				const head = headBytes(abs);
				if (head && !hasImageMagic(head) && looksBinary(head)) {
					return text(
						`"${params.path}" is a binary file (${formatSize(statSync(abs).size)}); read only returns text, so its bytes are not shown. Use bash (od, xxd or strings) if you really need to inspect it.`,
					);
				}
			} catch {
				// Pre-checks are best-effort: on any surprise, let the real tool answer.
			}
			const result: any = await (base.execute as any)(toolCallId, params, signal, onUpdate, ctx);
			// Image result: append the original file's dimensions and size.
			if (Array.isArray(result?.content) && result.content.some((c: any) => c.type === "image")) {
				try {
					const buf = readFileSync(abs);
					const dims = imageDimensions(buf);
					const meta = `${dims ? `${dims.w}×${dims.h}, ` : ""}${formatSize(buf.length)}`;
					result.content = result.content.map((c: any) =>
						c.type === "text" ? { ...c, text: `${c.text} (${meta})` } : c,
					);
				} catch {}
			}
			return result;
		},
	};
}

function patchedWrite(cwd: string) {
	const base = createWriteToolDefinition(cwd);
	return {
		...base,
		execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
			try {
				return await (base.execute as any)(toolCallId, params, signal, onUpdate, ctx);
			} catch (e) {
				const msg = (e as Error)?.message ?? String(e);
				if (/EACCES|EPERM|EROFS|permission denied|read-only file system/i.test(msg)) {
					throw new Error(
						`${msg}\nIn this app, files can be written inside the workspace (${cwd}) or the app temp dir ($TMPDIR); system paths such as /tmp are not writable.`,
					);
				}
				throw e;
			}
		},
	};
}

function patchedEdit(cwd: string) {
	const base = createEditToolDefinition(cwd);
	return {
		...base,
		execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
			try {
				return await (base.execute as any)(toolCallId, params, signal, onUpdate, ctx);
			} catch (e) {
				const msg = (e as Error)?.message ?? String(e);
				if (/occurrences/i.test(msg) && /unique/i.test(msg) && Array.isArray(params?.edits)) {
					try {
						const content = readFileSync(resolveIn(cwd, params.path as string), "utf8");
						const notes: string[] = [];
						params.edits.forEach((edit: any, i: number) => {
							if (typeof edit?.oldText !== "string" || !edit.oldText) return;
							const lines: number[] = [];
							let idx = content.indexOf(edit.oldText);
							while (idx >= 0) {
								lines.push(content.slice(0, idx).split("\n").length);
								idx = content.indexOf(edit.oldText, idx + 1);
							}
							if (lines.length > 1) notes.push(`edits[${i}].oldText occurs at lines ${lines.join(", ")}`);
						});
						if (notes.length) throw new Error(`${msg}\n${notes.join("\n")}`);
					} catch (inner) {
						if (inner instanceof Error && inner.message.includes("occurs at lines")) throw inner;
						// Locating the matches failed; fall through to the original error.
					}
				}
				throw e;
			}
		},
	};
}

/** Upper bound for the counting pass; past it the total is reported as "N+". */
const COUNT_CAP = 100_000;

/**
 * Shared logic for grep/find: when the base tool cut its result at the
 * limit, count the true total with a second pass and rewrite the closing
 * note to "Showing X of Y". Any failure leaves the original result as is.
 */
async function withTotal(
	base: any,
	toolCallId: string,
	params: any,
	signal: any,
	onUpdate: any,
	ctx: any,
	kind: "grep" | "find",
): Promise<any> {
	const result: any = await (base.execute as any)(toolCallId, params, signal, onUpdate, ctx);
	const limitKey = kind === "grep" ? "matchLimitReached" : "resultLimitReached";
	const shown = result?.details?.[limitKey];
	if (typeof shown !== "number" || !Array.isArray(result?.content)) return result;
	try {
		const countParams =
			kind === "grep" ? { ...params, limit: COUNT_CAP, context: 0 } : { ...params, limit: COUNT_CAP };
		const full: any = await (base.execute as any)(toolCallId, countParams, signal, onUpdate, ctx);
		const fullText = (full?.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text as string)
			.join("\n");
		const body = fullText.replace(/\n\n\[[^\]]*limit reached[^\]]*\]\s*$/, "");
		const total = body.split("\n").filter((l: string) => l.trim()).length;
		const stillCut =
			typeof full?.details?.[limitKey] === "number" || full?.details?.truncation?.truncated === true;
		if (total <= shown && !stillCut) return result;
		const noun = kind === "grep" ? "matches" : "results";
		result.content = result.content.map((c: any) => {
			if (c.type !== "text") return c;
			const rewritten = c.text.replace(
				/\[\d+ (?:matches|results) limit reached\. Use limit=\d+ for more, or refine pattern\]/,
				`[Showing ${shown} of ${total}${stillCut ? "+" : ""} ${noun}. Use limit=${shown * 2} for more, or refine pattern]`,
			);
			return rewritten === c.text ? c : { ...c, text: rewritten };
		});
		return result;
	} catch {
		return result;
	}
}

function patchedGrep(cwd: string) {
	const base = createGrepToolDefinition(cwd);
	return {
		...base,
		execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
			withTotal(base, toolCallId, params, signal, onUpdate, ctx, "grep"),
	};
}

function patchedFind(cwd: string) {
	const base = createFindToolDefinition(cwd);
	return {
		...base,
		execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
			withTotal(base, toolCallId, params, signal, onUpdate, ctx, "find"),
	};
}

/** Drop-in replacements for pi's read/write/edit/grep/find, registered via customTools. */
export function patchedTools(cwd: string, opts?: { autoResizeImages?: boolean }) {
	return [
		patchedRead(cwd, opts?.autoResizeImages ?? true),
		patchedWrite(cwd),
		patchedEdit(cwd),
		patchedGrep(cwd),
		patchedFind(cwd),
	] as any[];
}
