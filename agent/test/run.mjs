// Test runner for the agent host: bundles test/*.test.ts with esbuild (already a devDependency; the sources import
// each other with ".js" suffixes, which node cannot resolve to .ts on its own) and runs the result with node:test.
//
//   npm test                 all tests
//   npm test -- guard zip    only test files whose name contains "guard" or "zip"
//
// The bundles go to agent/.test-out (git-ignored). The pi SDK stays external, exactly as in build.mjs, so it
// resolves from agent/node_modules.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, ".test-out");
const filters = process.argv.slice(2);

const entries = readdirSync(here)
	.filter((f) => f.endsWith(".test.ts") && (filters.length === 0 || filters.some((x) => f.includes(x))))
	.map((f) => join(here, f));
if (entries.length === 0) {
	console.error(filters.length ? `No test files match: ${filters.join(", ")}` : "No test files found");
	process.exit(1);
}

rmSync(out, { recursive: true, force: true });
const shared = {
	outdir: out,
	// package.json says "type": "commonjs", so ESM output must be .mjs.
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: "inline",
	external: ["@earendil-works/pi-coding-agent"],
	// Same shim as build.mjs: bundled CommonJS dependencies require() Node builtins.
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
	logLevel: "warning",
};
await build({ ...shared, entryPoints: entries });
// The Flutter tests drive the real fs code through this stand-in host (see test/harness/fs_server.ts).
await build({ ...shared, outdir: join(out, "harness"), entryPoints: [join(here, "harness", "fs_server.ts")] });
// The real host, for the tests that start it as a process (daemon mode and stdio mode).
await build({ ...shared, outdir: join(out, "harness"), entryPoints: [join(here, "..", "src", "host.ts")] });

const files = readdirSync(out)
	.filter((f) => f.endsWith(".mjs"))
	.map((f) => join(out, f));
const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...files], { stdio: "inherit", cwd: root });
process.exit(result.status ?? 1);
