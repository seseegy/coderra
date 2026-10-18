import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.js";

// server/box/box, the launcher that runs bash inside the rootless container. Podman is replaced by a stub that records
// what it is asked to do, so these check the script's decisions without needing a container runtime.

const BOX = fileURLToPath(new URL("../../server/box/box", import.meta.url));

/** A fake podman: state lives in files so the script's `container inspect` / `start` / `run` behave plausibly. */
const PODMAN = `#!/bin/bash
dir="$STUB_DIR"
cmd="$1"
shift
line="$cmd"
for a in "$@"; do line="$line"$'\\t'"$a"; done
# One write per call, so concurrent calls never interleave inside a line.
printf '%s\\n' "$line" >> "$dir/calls.log"
case "$cmd" in
  container)
    [ -f "$dir/state" ] && cat "$dir/state" && exit 0
    exit 125 ;;
  image) [ -f "$dir/image" ] ;;
  run) sleep "\${STUB_RUN_DELAY:-0}"; echo running > "$dir/state"; echo container-id ;;
  start) echo running > "$dir/state" ;;
  rm) rm -f "$dir/state" ;;
  exec) exit "\${STUB_EXEC_EXIT:-0}" ;;
esac
`;

function setup(t: TestContext, opts: { image?: boolean; state?: string } = {}) {
	const home = tempDir(t);
	const bin = join(home, "bin");
	const stub = join(home, "stub");
	mkdirSync(bin);
	mkdirSync(stub);
	writeFileSync(join(bin, "podman"), PODMAN);
	chmodSync(join(bin, "podman"), 0o755);
	if (opts.image !== false) writeFileSync(join(stub, "image"), "");
	if (opts.state) writeFileSync(join(stub, "state"), `${opts.state}\n`);
	const ws = join(home, "workspace");
	mkdirSync(join(ws, "proj"), { recursive: true });
	const env: Record<string, string> = {
		PATH: `${bin}:${process.env.PATH}`,
		HOME: home,
		ANDROPI_WORKSPACE: ws,
		STUB_DIR: stub,
		TERM: "xterm",
	};
	const calls = () =>
		existsSync(join(stub, "calls.log"))
			? readFileSync(join(stub, "calls.log"), "utf8").trim().split("\n").map((l) => l.split("\t"))
			: [];
	const run = (args: string[], extra: Record<string, string> = {}, cwd = ws) =>
		spawnSync("bash", [BOX, ...args], { env: { ...env, ...extra }, cwd, encoding: "utf8" });
	const verbs = () => calls().map((c) => (c[0] === "container" || c[0] === "image" ? `${c[0]} ${c[1]}` : c[0]));
	return { home, ws, stub, env, calls, run, verbs };
}

test("first use creates the container with the limits and mounts, then runs the command in it", (t) => {
	const b = setup(t);
	const r = b.run(["-c", "echo hi"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(b.verbs(), ["container inspect", "image exists", "run", "exec"]);

	const run = b.calls().find((c) => c[0] === "run")!;
	const has = (...seq: string[]) => run.join("\t").includes(seq.join("\t"));
	assert.ok(has("-d", "--name", "coderra-box"));
	assert.ok(has("--init"));
	assert.ok(has("--network=host"));
	assert.ok(has("--memory", "2g", "--memory-swap", "3g", "--cpus", "1.5"));
	assert.ok(has("-v", `${b.home}/.coderra/box-home:${b.home}`));
	assert.ok(has("-v", `${b.ws}:${b.ws}`));
	assert.ok(has("localhost/coderra-box", "sleep", "infinity"));

	const exec = b.calls().find((c) => c[0] === "exec")!;
	assert.deepEqual(exec.slice(-4), ["coderra-box", "/bin/bash", "-c", "echo hi"]);
	assert.ok(exec.includes("-i"));
	assert.equal(exec.includes("-t"), false, "no terminal when stdin is not one");
	assert.ok(exec.join("\t").includes(["-w", b.ws].join("\t")));
});

test("a stopped container is started, a running one is left alone", (t) => {
	const stopped = setup(t, { state: "exited" });
	assert.equal(stopped.run(["-c", "true"]).status, 0);
	assert.deepEqual(stopped.verbs().filter((v) => v === "start" || v === "run"), ["start"]);

	const running = setup(t, { state: "running" });
	assert.equal(running.run(["-c", "true"]).status, 0);
	assert.deepEqual(running.verbs().filter((v) => v === "start" || v === "run"), []);
});

test("with no arguments it opens a login shell", (t) => {
	const b = setup(t, { state: "running" });
	b.run([]);
	assert.deepEqual(b.calls().find((c) => c[0] === "exec")!.slice(-3), ["coderra-box", "/bin/bash", "-l"]);
});

test("the command's exit status comes back", (t) => {
	const b = setup(t, { state: "running" });
	assert.equal(b.run(["-c", "exit 7"], { STUB_EXEC_EXIT: "7" }).status, 7);
});

test("it runs in the caller's folder inside the workspace, and in the workspace from anywhere else", (t) => {
	const b = setup(t, { state: "running" });
	const cwdOf = () => {
		const exec = b.calls().filter((c) => c[0] === "exec").at(-1)!;
		return exec[exec.indexOf("-w") + 1];
	};
	b.run(["-c", "pwd"], {}, join(b.ws, "proj"));
	assert.equal(cwdOf(), join(b.ws, "proj"));
	b.run(["-c", "pwd"], {}, "/tmp");
	assert.equal(cwdOf(), b.ws);
	b.run(["-c", "pwd"], {}, b.home);
	assert.equal(cwdOf(), b.home);
});

test("tokens are passed by name only, never as values", (t) => {
	const b = setup(t, { state: "running" });
	b.run(["-c", "git push"], { GITHUB_TOKEN: "ghp_SECRETVALUE", VERCEL_TOKEN: "vc_SECRETVALUE" });
	const exec = b.calls().find((c) => c[0] === "exec")!;
	assert.ok(exec.includes("GITHUB_TOKEN"));
	assert.ok(exec.includes("VERCEL_TOKEN"));
	assert.equal(exec.includes("GH_TOKEN"), false, "unset ones are not mentioned");
	assert.equal(readFileSync(join(b.stub, "calls.log"), "utf8").includes("SECRETVALUE"), false);
	assert.ok(exec.includes("GIT_TERMINAL_PROMPT=0"), "git must never wait for a prompt nobody can answer");
});

test("limits come from the environment or box.conf", (t) => {
	const b = setup(t);
	mkdirSync(join(b.home, ".coderra"), { recursive: true });
	writeFileSync(join(b.home, ".coderra", "box.conf"), "BOX_MEMORY=6g\nBOX_CPUS=3\n");
	b.run(["-c", "true"]);
	const run = b.calls().find((c) => c[0] === "run")!.join("\t");
	assert.ok(run.includes(["--memory", "6g", "--memory-swap", "3g", "--cpus", "3"].join("\t")));
});

test("without the image it explains how to get it and starts nothing", (t) => {
	const b = setup(t, { image: false });
	const r = b.run(["-c", "true"]);
	assert.equal(r.status, 127);
	assert.match(r.stderr, /image localhost\/coderra-box is missing/);
	assert.deepEqual(b.verbs().filter((v) => v === "run" || v === "exec"), []);
});

test("--reset removes the container", (t) => {
	const b = setup(t, { state: "running" });
	assert.equal(b.run(["--reset"]).status, 0);
	assert.deepEqual(b.verbs(), ["rm"]);
	assert.equal(existsSync(join(b.stub, "state")), false);
});

test("git and ssh settings are copied into the container's home, but authorized_keys never is", (t) => {
	const b = setup(t, { state: "running" });
	mkdirSync(join(b.home, ".ssh"), { mode: 0o700 });
	writeFileSync(join(b.home, ".gitconfig"), "[user]\n\tname = A\n");
	writeFileSync(join(b.home, ".ssh", "config"), "Host x\n");
	writeFileSync(join(b.home, ".ssh", "id_ed25519"), "PRIVATE");
	writeFileSync(join(b.home, ".ssh", "id_ed25519.pub"), "PUBLIC");
	writeFileSync(join(b.home, ".ssh", "known_hosts"), "host-a ssh-ed25519 AAA\n");
	writeFileSync(join(b.home, ".ssh", "authorized_keys"), "ssh-ed25519 THE-APPS-KEY\n");
	b.run(["-c", "true"]);

	const boxHome = join(b.home, ".coderra", "box-home");
	assert.equal(readFileSync(join(boxHome, ".gitconfig"), "utf8"), "[user]\n\tname = A\n");
	assert.equal(readFileSync(join(boxHome, ".ssh", "id_ed25519"), "utf8"), "PRIVATE");
	assert.equal(statSync(join(boxHome, ".ssh", "id_ed25519")).mode & 0o777, 0o600);
	assert.equal(statSync(boxHome).mode & 0o777, 0o700);
	assert.equal(existsSync(join(boxHome, ".ssh", "authorized_keys")), false);

	// Changes outside reach the box on the next call; what the box learned for itself stays.
	writeFileSync(join(b.home, ".gitconfig"), "[user]\n\tname = B\n");
	writeFileSync(join(boxHome, ".ssh", "known_hosts"), "learned-inside ssh-ed25519 BBB\n");
	b.run(["-c", "true"]);
	assert.equal(readFileSync(join(boxHome, ".gitconfig"), "utf8"), "[user]\n\tname = B\n");
	assert.equal(readFileSync(join(boxHome, ".ssh", "known_hosts"), "utf8"), "learned-inside ssh-ed25519 BBB\n");

	// A setting removed outside disappears inside.
	writeFileSync(join(b.home, ".gitconfig"), "");
	spawnSync("rm", [join(b.home, ".gitconfig")]);
	b.run(["-c", "true"]);
	assert.equal(existsSync(join(boxHome, ".gitconfig")), false);
});

test("two calls at once on first use create the container only once", async (t) => {
	const b = setup(t);
	const go = () =>
		new Promise<number | null>((resolve) => {
			const c = spawn("bash", [BOX, "-c", "true"], { env: { ...b.env, STUB_RUN_DELAY: "0.4" }, cwd: b.ws, stdio: "ignore" });
			c.on("exit", resolve);
		});
	const codes = await Promise.all([go(), go(), go()]);
	assert.deepEqual(codes, [0, 0, 0]);
	assert.equal(b.verbs().filter((v) => v === "run").length, 1);
	assert.equal(b.verbs().filter((v) => v === "exec").length, 3);
});
