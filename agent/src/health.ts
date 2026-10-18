/**
 * Keeping an eye on the machine the host runs on. An agent left to work for a day can fill a disk with build output,
 * checkpoints and session logs, and a full disk takes the whole server down with it. So: warn early, and refuse new
 * work before it gets that far.
 */

import { statfs } from "node:fs/promises";
import { FsError } from "./fs.js";

const MB = 1024 * 1024;
export const GB = 1024 * MB;

export interface HealthLimits {
	/** Free space below this is "low": warn. */
	diskWarnBytes: number;
	/** Free space below this is "critical": refuse new prompts and runs. */
	diskMinBytes: number;
	/** Resident memory above this is "high": warn (the service has its own hard limit above it). */
	memoryWarnBytes: number;
}

export const DEFAULT_HEALTH_LIMITS: HealthLimits = { diskWarnBytes: 10 * GB, diskMinBytes: 5 * GB, memoryWarnBytes: 1100 * MB };

export type DiskLevel = "ok" | "low" | "critical";
export type MemoryLevel = "ok" | "high";

export interface HealthSnapshot {
	disk: { path: string; freeBytes: number; totalBytes: number; level: DiskLevel };
	memory: { rssBytes: number; heapUsedBytes: number; level: MemoryLevel };
}

export type HealthChange =
	| { what: "disk"; from: DiskLevel; to: DiskLevel; freeBytes: number }
	| { what: "memory"; from: MemoryLevel; to: MemoryLevel; rssBytes: number };

export const humanBytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`);

export interface HealthOptions {
	/** A folder on the disk that matters (the workspace). */
	path: string;
	limits?: Partial<HealthLimits>;
	/** When false the disk is watched and reported but never refuses work (a phone's storage is the user's business). */
	enforce?: boolean;
	onChange?: (change: HealthChange) => void;
	// Replaceable for tests.
	statfs?: (path: string) => Promise<{ bsize: number; bavail: number; blocks: number }>;
	memory?: () => { rss: number; heapUsed: number };
}

export class Health {
	private readonly limits: HealthLimits;
	private disk: DiskLevel = "ok";
	private mem: MemoryLevel = "ok";
	private timer?: NodeJS.Timeout;

	constructor(private readonly o: HealthOptions) {
		this.limits = { ...DEFAULT_HEALTH_LIMITS, ...o.limits };
	}

	private async free() {
		const s = await (this.o.statfs ?? statfs)(this.o.path);
		return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
	}

	private diskLevel(free: number, from: DiskLevel): DiskLevel {
		const { diskWarnBytes: warn, diskMinBytes: min } = this.limits;
		const rank: Record<DiskLevel, number> = { ok: 0, low: 1, critical: 2 };
		const now: DiskLevel = free < min ? "critical" : free < warn ? "low" : "ok";
		if (rank[now] >= rank[from]) return now;
		// Getting better needs a 10% margin past the line, so a disk hovering at it does not flap between levels.
		if (free >= warn * 1.1) return "ok";
		if (free >= min * 1.1) return "low";
		return from;
	}

	async snapshot(): Promise<HealthSnapshot> {
		const { freeBytes, totalBytes } = await this.free();
		const m = (this.o.memory ?? process.memoryUsage)();
		return {
			disk: { path: this.o.path, freeBytes, totalBytes, level: this.diskLevel(freeBytes, this.disk) },
			memory: { rssBytes: m.rss, heapUsedBytes: m.heapUsed, level: m.rss > this.limits.memoryWarnBytes ? "high" : "ok" },
		};
	}

	/** Looks now and reports any change of level since the last look. */
	async check(): Promise<HealthSnapshot> {
		const snap = await this.snapshot();
		if (snap.disk.level !== this.disk) {
			const from = this.disk;
			this.disk = snap.disk.level;
			this.o.onChange?.({ what: "disk", from, to: snap.disk.level, freeBytes: snap.disk.freeBytes });
		}
		if (snap.memory.level !== this.mem) {
			const from = this.mem;
			this.mem = snap.memory.level;
			this.o.onChange?.({ what: "memory", from, to: snap.memory.level, rssBytes: snap.memory.rssBytes });
		}
		return snap;
	}

	/** Throws (code `disk_low`) if there is too little room to start more work. A failure to look is not a reason to refuse. */
	async assertRoom(): Promise<void> {
		if (this.o.enforce === false) return;
		let snap: HealthSnapshot;
		try {
			snap = await this.check();
		} catch {
			return;
		}
		if (snap.disk.level === "critical") {
			throw new FsError(
				"disk_low",
				`The disk is almost full (${humanBytes(snap.disk.freeBytes)} free, at least ${humanBytes(this.limits.diskMinBytes)} needed). Free some space, then try again.`,
			);
		}
	}

	/** Checks now and then in the background; the timer does not keep the process alive. */
	start(everyMs = 5 * 60_000) {
		void this.check().catch(() => {});
		this.timer = setInterval(() => void this.check().catch(() => {}), everyMs);
		this.timer.unref();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
