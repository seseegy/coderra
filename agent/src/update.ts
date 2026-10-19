/**
 * In-app update check for CoderRa (fork addition).
 *
 * CI publishes every main build as a GitHub Release tagged `b<run number>`
 * in seseegy/coderra and builds the APK with --build-number=<run number>,
 * so comparing numbers is enough. The running build reaches the host as
 * ANDROPI_APP_BUILD / ANDROPI_APP_VERSION (set by AgentRuntime from the
 * package manager). Split-per-ABI APKs add an ABI offset to versionCode;
 * AgentRuntime strips it (versionCode % 1000) so the value is the run number. The check needs the user's GitHub sign-in because the
 * repository is private, and successful lookups are cached for 6 hours in
 * <agentDir>/andropi/update-check.json so opening Settings stays cheap.
 */
import { createWriteStream, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = "seseegy/coderra";
const CACHE_MS = 6 * 3600_000;

export interface UpdateCheck {
	status: "available" | "current" | "none" | "signed-out" | "error";
	currentBuild: number;
	currentVersion: string;
	latestBuild?: number;
	tag?: string;
	title?: string;
	url?: string;
	assetName?: string;
	assetSize?: number;
	message?: string;
}

/** Which build of the app is asking: its own numbers (a server's environment says nothing about the phone) and its CPU. */
export interface AppIdentity {
	build?: number;
	version?: string;
	/** `arm64-v8a`, `armeabi-v7a` or `x86_64`: the release has one APK for each. */
	abi?: string;
}

/** The release APK asset for [abi] (arm64 when not said or not found), else the first APK. */
export function pickAsset(rel: any, abi?: string): { id: number; name: string; size: number } | null {
	const assets = Array.isArray(rel?.assets) ? rel.assets : [];
	const apks = assets.filter(
		(a: any) => typeof a?.name === "string" && a.name.endsWith(".apk") && typeof a?.id === "number",
	);
	const wanted = abi && /^[a-z0-9_-]+$/i.test(abi) ? abi : "arm64";
	const pick = apks.find((a: any) => a.name.includes(wanted)) ?? apks.find((a: any) => a.name.includes("arm64")) ?? apks[0];
	return pick ? { id: pick.id, name: pick.name, size: Number(pick.size) || 0 } : null;
}

interface Latest {
	latestBuild: number;
	tag: string;
	title: string;
	url: string;
	assets: unknown;
}

export async function checkAppUpdate(
	agentDir: string,
	githubApi: (path: string) => Promise<any>,
	force = false,
	app: AppIdentity = {},
): Promise<UpdateCheck> {
	// The app says which build it is; the environment is only what a host running on the phone itself knows.
	const currentBuild = app.build ?? (Number.parseInt(process.env.ANDROPI_APP_BUILD ?? "", 10) || 0);
	const currentVersion = app.version ?? process.env.ANDROPI_APP_VERSION ?? "";
	const base = { currentBuild, currentVersion };
	const stateDir = join(agentDir, "andropi");
	const cacheFile = join(stateDir, "update-check.json");

	// What is cached is the newest release, never the verdict: the verdict depends on who is asking.
	const answer = (latest: Latest): UpdateCheck => {
		const asset = pickAsset({ assets: latest.assets }, app.abi);
		return {
			...base,
			status: latest.latestBuild > currentBuild ? "available" : "current",
			latestBuild: latest.latestBuild,
			tag: latest.tag,
			title: latest.title,
			url: latest.url,
			...(asset ? { assetName: asset.name, assetSize: asset.size } : {}),
		};
	};

	if (!force) {
		try {
			const c = JSON.parse(readFileSync(cacheFile, "utf8"));
			if (c.v === 2 && Date.now() - Number(c.at ?? 0) < CACHE_MS) {
				return c.latest ? answer(c.latest as Latest) : { ...base, status: "none" };
			}
		} catch {
			// No (readable) cache yet.
		}
	}

	let latest: Latest | null = null;
	let result: UpdateCheck;
	try {
		const rel = await githubApi(`/repos/${REPO}/releases/latest`);
		const tag = String(rel?.tag_name ?? "");
		latest = {
			latestBuild: Number.parseInt(tag.replace(/^b/, ""), 10) || 0,
			tag,
			title: typeof rel?.name === "string" ? rel.name : tag,
			url: typeof rel?.html_url === "string" ? rel.html_url : "",
			assets: Array.isArray(rel?.assets) ? rel.assets.map((a: any) => ({ id: a?.id, name: a?.name, size: a?.size })) : [],
		};
		result = answer(latest);
	} catch (e: any) {
		if (e?.status === 404) result = { ...base, status: "none" };
		else if (/not signed in/i.test(String(e?.message ?? e))) result = { ...base, status: "signed-out" };
		else result = { ...base, status: "error", message: String(e?.message ?? e).slice(0, 160) };
	}

	// Only cache real answers; a sign-in or a network blip must not stick around for six hours.
	if (result.status === "available" || result.status === "current" || result.status === "none") {
		try {
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(cacheFile, JSON.stringify({ v: 2, at: Date.now(), latest }));
		} catch {
			// Cache is best-effort.
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Direct APK download: the app fetches the release asset itself (with the
// user's GitHub token, since the repo is private) so an update never has
// to leave the app. The file lands in <agentDir>/updates, which is inside
// filesDir and therefore servable by the app's FileProvider installer.

export interface UpdateDownload {
	id?: string;
	state: "downloading" | "done" | "error" | "cancelled";
	received: number;
	total: number;
	path?: string;
	tag?: string;
	message?: string;
}

interface DownloadJob extends UpdateDownload {
	id: string;
	file: string;
	abort?: AbortController;
}

const downloads = new Map<string, DownloadJob>();
let downloadSeq = 0;
/** The download started last: what the app shows again when its screen is opened anew. */
let latestId: string | undefined;

const view = ({ file: _file, abort: _abort, ...rec }: DownloadJob): UpdateDownload => ({ ...rec });

/**
 * Starts downloading the latest release's APK, or joins what is already there: a download of the same file that is
 * still going is not started twice, and a file that is already complete is not fetched again.
 */
export async function startAppUpdateDownload(
	agentDir: string,
	githubApi: (path: string) => Promise<any>,
	githubRaw: (path: string, init?: RequestInit) => Promise<Response>,
	abi?: string,
): Promise<{ id: string; name: string; size: number; tag: string }> {
	const rel = await githubApi(`/repos/${REPO}/releases/latest`);
	const asset = pickAsset(rel, abi);
	if (!asset) throw new Error("The latest release has no APK attached");
	const tag = String(rel?.tag_name ?? "b0");
	const dir = join(agentDir, "updates");
	mkdirSync(dir, { recursive: true });
	// The names come from GitHub: whatever they hold, the file stays in this folder.
	const file = join(dir, `${tag}-${asset.name}`.replace(/[^A-Za-z0-9._-]/g, "_"));
	const answer = (job: DownloadJob) => {
		latestId = job.id;
		return { id: job.id, name: asset.name, size: asset.size, tag };
	};

	const going = [...downloads.values()].find((j) => j.file === file && j.state === "downloading");
	if (going) return answer(going);

	const id = `u${++downloadSeq}`;
	const job: DownloadJob = { id, file, state: "downloading", received: 0, total: asset.size, tag };
	downloads.set(id, job);
	if (asset.size > 0 && sizeOf(file) === asset.size) {
		Object.assign(job, { state: "done", received: asset.size, path: file });
		return answer(job);
	}

	// Written beside the final name and renamed when complete, so a half-written file is never taken for the APK.
	const part = `${file}.part`;
	const abort = new AbortController();
	job.abort = abort;
	void (async () => {
		try {
			const res = await githubRaw(`/repos/${REPO}/releases/assets/${asset.id}`, {
				headers: { Accept: "application/octet-stream" },
				signal: abort.signal,
			});
			if (!res.ok || !res.body) throw new Error(`GitHub download failed (${res.status})`);
			const source = Readable.fromWeb(res.body as any);
			source.on("data", (chunk: Buffer) => {
				job.received += chunk.length;
			});
			await pipeline(source, createWriteStream(part), { signal: abort.signal });
			const size = statSync(part).size;
			if (asset.size && size !== asset.size) {
				throw new Error(`Download incomplete (${size} of ${asset.size} bytes)`);
			}
			renameSync(part, file);
			job.state = "done";
			job.path = file;
		} catch (e: any) {
			if (job.state === "downloading") {
				job.state = "error";
				job.message = String(e?.message ?? e).slice(0, 200);
			}
			try {
				unlinkSync(part);
			} catch {
				// Partial file may not exist.
			}
		} finally {
			job.abort = undefined;
		}
	})();
	return answer(job);
}

function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return -1;
	}
}

/** One download by its id; without an id, the one started last (or "idle" when there is none). */
export function appUpdateDownloadStatus(id?: string): UpdateDownload | { state: "idle" } {
	if (!id) {
		const last = latestId ? downloads.get(latestId) : undefined;
		return last ? view(last) : { state: "idle" };
	}
	const job = downloads.get(id);
	return job ? view(job) : { state: "error", received: 0, total: 0, message: "Unknown download" };
}

/**
 * The user stopped it. A download that is going is aborted and its partial file removed; one that is complete keeps
 * its file (a later start finds it), but is no longer offered to a screen that opens anew.
 */
export function cancelAppUpdateDownload(id: string): UpdateDownload | { state: "idle" } {
	const job = downloads.get(id);
	if (!job) return { state: "idle" };
	if (job.state === "downloading" || job.state === "done") {
		job.state = "cancelled";
		job.abort?.abort();
	}
	return view(job);
}
