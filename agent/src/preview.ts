/**
 * Showing a project's web pages to the app. On a server the pages are files on the server, and a WebView on the phone
 * cannot open them by path; this serves a folder over HTTP on the server's own loopback, and the app reaches it through
 * an ssh port forward.
 *
 * Because anything on the server's loopback can be reached by every user of that machine, and anything on the phone's
 * loopback by every app on the phone, each server also has a random token as the first part of every URL: a request
 * without it gets a 404, and the token never leaves the host-to-app link.
 *
 * What is served is fenced: only inside the folder (after following symbolic links), never a file or folder whose name
 * starts with a dot (.git, .env, ...), no listings, GET and HEAD only. A server stops by itself when nobody has asked it
 * for anything for a while.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, resolve } from "node:path";
import { FsError } from "./fs.js";
import { isInside } from "./guard.js";

export interface PreviewOptions {
	/** Folders a preview may be made of (and anything inside them). */
	roots: string[];
	/** A server with no request for this long is stopped. */
	idleMs?: number;
	maxServers?: number;
}

export interface PreviewInfo {
	port: number;
	/** First part of every URL: `http://127.0.0.1:<port>/<token>/<file>`. */
	token: string;
	dir: string;
}

interface Entry extends PreviewInfo {
	server: Server;
	timer?: NodeJS.Timeout;
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".pdf": "application/pdf",
	".xml": "application/xml; charset=utf-8",
};

export class Preview {
	private readonly entries = new Map<number, Entry>();
	private readonly idleMs: number;
	private readonly maxServers: number;

	constructor(private readonly o: PreviewOptions) {
		this.idleMs = o.idleMs ?? 30 * 60_000;
		this.maxServers = o.maxServers ?? 4;
	}

	/** Starts (or finds) the server for [dir] and says where it is. */
	async serve(dir: unknown): Promise<PreviewInfo> {
		if (typeof dir !== "string" || !isAbsolute(dir)) throw new FsError("bad_path", "dir must be an absolute path");
		let real: string;
		try {
			real = await realpath(dir);
		} catch {
			throw new FsError("ENOENT", `${dir} does not exist`);
		}
		if (!(await stat(real)).isDirectory()) throw new FsError("not_dir", `${dir} is not a folder`);
		const roots = await Promise.all(this.o.roots.map((r) => realpath(r).catch(() => resolve(r))));
		if (!roots.some((r) => isInside(real, r))) throw new FsError("outside_root", "That folder is outside the places the app may open");

		for (const e of this.entries.values()) {
			if (e.dir === real) {
				this.touch(e);
				return { port: e.port, token: e.token, dir: real };
			}
		}
		if (this.entries.size >= this.maxServers) throw new FsError("busy", `${this.maxServers} previews are already running; close one first`);

		const token = randomBytes(12).toString("hex");
		const server = createServer((req, res) => void this.handle(entry, req, res).catch(() => this.fail(res, 500)));
		const entry: Entry = { server, port: 0, token, dir: real };
		await new Promise<void>((ok, bad) => {
			server.once("error", bad);
			server.listen(0, "127.0.0.1", () => ok());
		});
		entry.port = (server.address() as AddressInfo).port;
		server.unref();
		this.entries.set(entry.port, entry);
		this.touch(entry);
		return { port: entry.port, token, dir: real };
	}

	stop(port: number): boolean {
		const e = this.entries.get(port);
		if (!e) return false;
		if (e.timer) clearTimeout(e.timer);
		this.entries.delete(port);
		e.server.close();
		e.server.closeAllConnections();
		return true;
	}

	stopAll() {
		for (const port of [...this.entries.keys()]) this.stop(port);
	}

	list(): PreviewInfo[] {
		return [...this.entries.values()].map(({ port, token, dir }) => ({ port, token, dir }));
	}

	private touch(e: Entry) {
		if (e.timer) clearTimeout(e.timer);
		e.timer = setTimeout(() => this.stop(e.port), this.idleMs);
		e.timer.unref();
	}

	private fail(res: ServerResponse, status: number) {
		if (res.headersSent) {
			res.destroy();
			return;
		}
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
		res.end(status === 404 ? "Not found" : status === 405 ? "Method not allowed" : "Error");
	}

	private async handle(e: Entry, req: IncomingMessage, res: ServerResponse) {
		this.touch(e);
		if (req.method !== "GET" && req.method !== "HEAD") return this.fail(res, 405);

		// /<token>/a/b.html ; anything else is "not found", so a wrong token reveals nothing.
		let path: string;
		try {
			path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		} catch {
			return this.fail(res, 404);
		}
		if (path.includes("\0") || path.includes("\\")) return this.fail(res, 404);
		const parts = path.split("/").filter((p, i) => !(p === "" && i > 0));
		if (parts[0] !== "" || parts[1] !== e.token) return this.fail(res, 404);
		const rel = parts.slice(2);
		// Dot segments never reach the disk, and neither does anything hidden.
		if (rel.some((p) => p === ".." || p === "." || p.startsWith("."))) return this.fail(res, 404);

		let real: string;
		let s: Stats;
		try {
			real = await realpath(join(e.dir, ...rel));
			if (!isInside(real, e.dir)) return this.fail(res, 404); // a link that leads out
			s = await stat(real);
			if (s.isDirectory()) {
				// Without the closing slash, relative links in the folder's page would resolve one level too high.
				if (!path.endsWith("/")) {
					res.writeHead(301, { location: `${path}/`, "cache-control": "no-store" });
					return void res.end();
				}
				real = await realpath(join(real, "index.html"));
				if (!isInside(real, e.dir)) return this.fail(res, 404);
				s = await stat(real);
			}
		} catch {
			return this.fail(res, 404);
		}
		if (!s.isFile()) return this.fail(res, 404);
		res.writeHead(200, {
			"content-type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
			"content-length": s.size,
			// The page is being edited while it is looked at.
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		if (req.method === "HEAD") return void res.end();
		const stream = createReadStream(real);
		stream.on("error", () => res.destroy());
		res.on("close", () => stream.destroy());
		stream.pipe(res);
	}
}
