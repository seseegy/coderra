/**
 * The agent's shell on a server: a rootless Podman container, entered through the `box` launcher (server/box/box). This is
 * the host's view of it for the app: is it there, is it running, how much does it use, and the few things a person may
 * need to do about it (check that it works, stop it, throw the container away, rebuild the image, wipe its home).
 *
 * Everything goes through the `podman` command line, never a library, and through the same `box` script the agent's
 * commands use, so what the app shows is what the agent gets. Each question is asked on its own and a failed one becomes
 * a `problem` in the answer: a screen about a broken container must still open.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { FsError } from "./fs.js";
import { type Log, run } from "./integrations.js";

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export type Exec = (file: string, args: string[], o?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Runs a command and never throws: a missing program or a timeout is a result like any other. */
export const defaultExec: Exec = (file, args, o) =>
	new Promise((resolveResult) => {
		execFile(file, args, { timeout: o?.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
			const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
			resolveResult({
				code: e ? (typeof e.code === "number" ? e.code : null) : 0,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? e?.message ?? ""),
				timedOut: !!e?.killed,
			});
		});
	});

export interface BoxOptions {
	/** server/box/box as installed on the server. */
	script: string;
	/** `~/.coderra`: holds box.conf, box-home and the Containerfile. */
	coderraDir: string;
	image?: string;
	name?: string;
	podman?: string;
	exec?: Exec;
	/** How long `check` waits for a command to run in the box (it may have to make the container first). */
	checkTimeoutMs?: number;
	/** Runs a long command and streams its output (podman build). */
	stream?: (cmd: string, args: string[], log: Log) => Promise<unknown>;
}

export interface BoxUsage {
	memoryBytes: number;
	/** null when the container has no limit. */
	memoryLimitBytes: number | null;
	processes: number;
}

export interface BoxLimits {
	memory: string;
	swap: string;
	cpus: string;
}

export interface BoxStatus {
	kind: "podman";
	/** The launcher is installed. Without it there is no box on this server. */
	available: boolean;
	/** The image the container is made from exists. */
	installed: boolean;
	state: "running" | "stopped" | "none" | "unknown";
	/** The agent's commands go through the box (and not straight to the server). */
	enabled: boolean;
	image: string;
	startedAt: string | null;
	usage: BoxUsage | null;
	limits: BoxLimits;
	/** Something that is wrong, in words, for the user. */
	problem: string | null;
	// Fields the phone's container status has, so the same screens can read both.
	distro: string | null;
	installedAt: null;
	distros: never[];
}

const DEFAULT_LIMITS: BoxLimits = { memory: "2g", swap: "3g", cpus: "1.5" };

export class PodmanBox {
	readonly image: string;
	readonly name: string;
	private readonly podman: string;
	private readonly exec: Exec;
	private readonly stream: NonNullable<BoxOptions["stream"]>;
	private working: string | null = null;

	constructor(private readonly o: BoxOptions) {
		this.image = o.image ?? "localhost/coderra-box";
		this.name = o.name ?? "coderra-box";
		this.podman = o.podman ?? "podman";
		this.exec = o.exec ?? defaultExec;
		this.stream = o.stream ?? ((cmd, args, log) => run(cmd, args, { cwd: o.coderraDir, log }));
	}

	get available() {
		return existsSync(this.o.script);
	}

	get script() {
		return this.o.script;
	}

	/** Where the container's home lives on the server. */
	get homeDir() {
		return process.env.CODERRA_BOX_HOME ?? join(this.o.coderraDir, "box-home");
	}

	/** The limits the container is made with (box.conf, then the script's own defaults). Applied when it is next created. */
	limits(): BoxLimits {
		const out = { ...DEFAULT_LIMITS };
		try {
			const conf = readFileSync(process.env.CODERRA_BOX_CONF ?? join(this.o.coderraDir, "box.conf"), "utf8");
			for (const [key, field] of [["BOX_MEMORY", "memory"], ["BOX_SWAP", "swap"], ["BOX_CPUS", "cpus"]] as const) {
				const m = new RegExp(`^\\s*${key}=["']?([0-9.]+[kKmMgG]?)["']?\\s*(?:#.*)?$`, "m").exec(conf);
				if (m) out[field] = m[1];
			}
		} catch {
			// No box.conf: the defaults.
		}
		return out;
	}

	async status(currentShell: string | undefined): Promise<BoxStatus> {
		const base: BoxStatus = {
			kind: "podman",
			available: this.available,
			installed: false,
			state: "none",
			enabled: false,
			image: this.image,
			startedAt: null,
			usage: null,
			limits: this.limits(),
			problem: null,
			distro: null,
			installedAt: null,
			distros: [],
		};
		if (!base.available) {
			return { ...base, problem: "There is no box on this server (the setup script was run with --no-box, or has not been run). The agent's commands run directly on the server." };
		}
		base.enabled = currentShell === this.o.script;

		const version = await this.exec(this.podman, ["--version"]);
		if (version.code !== 0) return { ...base, state: "unknown", problem: "Podman is not installed for this user, or does not start." };

		const image = await this.exec(this.podman, ["image", "exists", this.image]);
		base.installed = image.code === 0;
		base.distro = base.installed ? "ubuntu" : null;

		const inspect = await this.exec(this.podman, ["container", "inspect", "--format", "{{.State.Status}}|{{.State.StartedAt}}", this.name]);
		if (inspect.code === 0) {
			const [status, started] = inspect.stdout.trim().split("|");
			base.state = status === "running" ? "running" : "stopped";
			if (base.state === "running") base.startedAt = started || null;
		} else if (inspect.timedOut) {
			base.state = "unknown";
			base.problem = "Podman did not answer in time.";
		} else {
			base.state = "none"; // no such container yet: it is made the first time a command needs it
		}

		if (!base.installed && !base.problem) {
			base.problem = "The box image has not been built. Rebuild it from this screen, or run the setup script again.";
		}
		if (base.state === "running") base.usage = await this.usage();
		return base;
	}

	/** Memory and process count from inside the container (cgroup v2); null if it cannot be read. */
	async usage(): Promise<BoxUsage | null> {
		const r = await this.exec(this.podman, [
			"exec",
			this.name,
			"sh",
			"-c",
			"cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max 2>/dev/null; ls /proc | grep -c '^[0-9][0-9]*$'",
		]);
		if (r.code !== 0) return null;
		const lines = r.stdout.trim().split("\n").map((l) => l.trim());
		if (lines.length < 3) return null;
		const used = Number(lines[0]);
		const max = lines[1] === "max" ? null : Number(lines[1]);
		const processes = Number(lines[2]);
		if (!Number.isFinite(used) || !Number.isFinite(processes) || (max !== null && !Number.isFinite(max))) return null;
		return { memoryBytes: used, memoryLimitBytes: max, processes };
	}

	/** Runs a trivial command through the launcher, the way the agent does: proves podman, the image and the mounts work. */
	async check(): Promise<{ ok: boolean; message: string }> {
		if (!this.available) return { ok: false, message: "There is no box on this server." };
		const r = await this.exec(this.o.script, ["-c", "echo box-works"], { timeoutMs: this.o.checkTimeoutMs ?? 180_000 });
		if (r.code === 0 && r.stdout.includes("box-works")) return { ok: true, message: "The box works: a command ran inside it." };
		if (r.timedOut) return { ok: false, message: "The box did not answer in three minutes. It may be building its container or stuck; try again, or reset it." };
		const why = r.stderr.trim().split("\n").filter(Boolean).slice(-3).join("\n");
		return { ok: false, message: why || `The box failed (exit code ${r.code}).` };
	}

	/** Work that changes the box one at a time: two resets at once would fight over the container. */
	private async exclusive<T>(what: string, job: () => Promise<T>): Promise<T> {
		if (this.working) throw new FsError("busy", `The box is busy (${this.working}). Wait for it to finish.`);
		this.working = what;
		try {
			return await job();
		} finally {
			this.working = null;
		}
	}

	private requireBox() {
		if (!this.available) throw new FsError("no_box", "There is no box on this server.");
	}

	/** Throws the container away (not the image, not its home folder). The next command makes a new one. */
	async reset(): Promise<void> {
		this.requireBox();
		return this.exclusive("resetting", async () => {
			const r = await this.exec(this.o.script, ["--reset"], { timeoutMs: 60_000 });
			if (r.code !== 0) throw new Error(`Could not remove the container: ${r.stderr.trim().split("\n").pop() || `exit code ${r.code}`}`);
		});
	}

	/** Stops the container to free its memory; the next command starts it again. */
	async stop(): Promise<void> {
		this.requireBox();
		return this.exclusive("stopping", async () => {
			const r = await this.exec(this.podman, ["stop", "-t", "10", this.name], { timeoutMs: 40_000 });
			// A container that is not there is already stopped.
			if (r.code !== 0 && !/no such container|no container with/i.test(r.stderr)) throw new Error(`Could not stop the container: ${r.stderr.trim().split("\n").pop()}`);
		});
	}

	/** Builds the image again from server/box/Containerfile (minutes), then drops the container so it is made from the new one. */
	async rebuildImage(log: Log): Promise<void> {
		this.requireBox();
		const dir = join(this.o.coderraDir, "box");
		if (!existsSync(join(dir, "Containerfile"))) throw new FsError("ENOENT", "The Containerfile is missing from the server. Run the setup script again.");
		return this.exclusive("rebuilding the image", async () => {
			await this.stream(this.podman, ["build", "-t", this.image, "-f", join(dir, "Containerfile"), dir], log);
			const r = await this.exec(this.o.script, ["--reset"], { timeoutMs: 60_000 });
			if (r.code !== 0) throw new Error(`The image was built, but the old container could not be removed: ${r.stderr.trim().split("\n").pop()}`);
		});
	}

	/**
	 * Empties the container's home folder (ssh and git settings it keeps, shell history, anything the agent saved there)
	 * after removing the container. The workspace is not touched.
	 */
	async wipeHome(): Promise<{ removed: number }> {
		this.requireBox();
		const home = resolve(this.homeDir);
		// A setting that points somewhere surprising must not turn into "delete that".
		if (basename(home) !== "box-home" || home.split("/").filter(Boolean).length < 3) throw new FsError("unsafe", `Refusing to empty ${home}: it does not look like the box's home folder.`);
		return this.exclusive("wiping its home", async () => {
			const r = await this.exec(this.o.script, ["--reset"], { timeoutMs: 60_000 });
			if (r.code !== 0) throw new Error(`Could not remove the container: ${r.stderr.trim().split("\n").pop()}`);
			await mkdir(home, { recursive: true, mode: 0o700 });
			let removed = 0;
			for (const name of await readdir(home)) {
				const target = join(home, name);
				try {
					await rm(target, { recursive: true, force: true });
				} catch (e) {
					// Files made by other users inside the container belong to numbers this user cannot touch from outside;
					// podman's own user namespace can.
					if (!["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
					const r = await this.exec(this.podman, ["unshare", "rm", "-rf", target], { timeoutMs: 120_000 });
					if (r.code !== 0) throw new Error(`Could not remove ${name}: ${r.stderr.trim().split("\n").pop()}`);
				}
				removed++;
			}
			await chmod(home, 0o700);
			return { removed };
		});
	}
}
