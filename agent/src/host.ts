/**
 * AndroPI agent host.
 *
 * Runs inside the bundled Node runtime on the device and exposes the pi SDK to
 * the Flutter app over JSONL on stdin/stdout:
 *
 *   app  -> host   {"id": 1, "type": "prompt", "text": "..."}
 *   host -> app    {"type": "response", "id": 1, "ok": true, "data": ...}
 *   host -> app    {"type": "event", "event": <pi session event>}
 *   host -> app    {"type": "auth_prompt" | "approval" | "task" | "runs" | ...}
 *
 * stdout is reserved for protocol records; logs go to stderr.
 *
 * With `--listen <socket path>` (or ANDROPI_LISTEN) the host instead runs as a daemon that outlives its clients:
 * it serves the same protocol on a unix socket, keeps recent records so a client that dropped can `resume`, and
 * stays up when the client disconnects. See transport.ts.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { AGENTS_MARKER, agentsFileText, LEGACY_STARTS } from "./agents-file.js";
import { Checkpoints } from "./checkpoints.js";
import { Fs, isFsCommand, runFsCommand } from "./fs.js";
import { Container, type Distro } from "./container.js";
import { installDohLookup } from "./dns.js";
import { appUpdateDownloadStatus, checkAppUpdate, startAppUpdateDownload } from "./update.js";
import * as gitops from "./gitops.js";
import { Guard } from "./guard.js";
import { Integrations, type Log } from "./integrations.js";
import { installLenientTools } from "./lenient.js";
import { Mcp } from "./mcp.js";
import { patchedTools } from "./patched-tools.js";
import { type RunSession, Runner } from "./runs.js";
import { Hub, LineBuffer, listenOnSocket, PROTOCOL, RestartGate, stdioConn } from "./transport.js";
import { DEFAULT_HEALTH_LIMITS, Health, type HealthChange, humanBytes } from "./health.js";
import { CONTINUE_CHAT, endsUnfinished } from "./interrupted.js";
import { Notifier } from "./notify.js";
import { createBackup, estimateBackup, restoreBackup } from "./backup.js";
import { PodmanBox } from "./podmanbox.js";
import { Preview } from "./preview.js";
import { backoffFromEnv, cancellableSleep, promptWithRetry } from "./retry.js";
import { type ChildSession, EXPLORER_TOOLS, type Role, Slots, type SubagentDeps, subagentTool } from "./subagent.js";
import { Skills } from "./skills.js";
import { latestChecklist, record as tasksRecord, tasksTool } from "./tasks.js";
import { webTools } from "./web.js";
import {
	dbQuery,
	dbTables,
	detectTests,
	search,
	Templates,
	Tunnels,
	usageSummary,
} from "./workbench.js";

type Command = { id?: number; type: string; [key: string]: any };

/** Built-in and app tools; MCP tools are added per session. This is the *active* set. */
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch", "web_screenshot", "tasks", "subagent"];

const agentDir = getAgentDir();
const workspace = process.env.ANDROPI_WORKSPACE ?? process.cwd();
const stateDir = join(agentDir, "andropi");

let modelRuntime: ModelRuntime;
let settingsManager: SettingsManager;
let session: AgentSession | undefined;
let integrations: Integrations;
let container: Container;
let skills: Skills;
let templates: Templates;
let checkpoints: Checkpoints;
let fsService: Fs;
let preview: Preview;
let runner: Runner;
let mcp: Mcp;
const tunnels = new Tunnels();
let unsubscribe: (() => void) | undefined;

const guard = new Guard({
	send: (r) => {
		send(r);
		if ((r as { type?: string }).type === "approval") void notifier.send("approval", "Approval needed", { priority: 4, tags: ["raised_hand"] });
	},
	checkpoint: async (cwd, label) => {
		await checkpoints.snapshot(cwd, label);
	},
	cwd: () => session?.sessionManager.getCwd() ?? workspace,
});

// ---------------------------------------------------------------------------
// Output

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Set when running as a daemon on a unix socket; unset when the app spawned this process and talks over stdio. */
const listenPath = argValue("--listen") ?? process.env.ANDROPI_LISTEN;

/** "vps" on a server, "local" on the phone. The daemon is a server unless told otherwise. */
const mode = process.env.ANDROPI_MODE ?? (listenPath ? "vps" : "local");

/** The launcher that runs bash inside the rootless container on a server (server/box/box). */
const boxScript = process.env.CODERRA_BOX ?? join(process.env.HOME ?? "", ".coderra", "bin", "box");

const hub = new Hub({
	replay: !!listenPath,
	mode,
	hostVersion: VERSION,
	handle: (cmd) => handle(cmd as Command),
	// Only tests shorten these.
	pingIntervalMs: Number(process.env.CODERRA_PING_MS) || undefined,
	idleTimeoutMs: Number(process.env.CODERRA_IDLE_MS) || undefined,
});
// The app that spawned us is connected from the first byte, so early records (startup notices) reach it.
const stdio = listenPath ? undefined : hub.attach(stdioConn());

function send(record: object) {
	hub.emit(record);
}

/** Where the host keeps its own small files on a server (the box script uses the same variable). */
const coderraDir = process.env.CODERRA_DIR ?? join(process.env.HOME ?? agentDir, ".coderra");
/** Exists while the daemon runs and is removed by a clean shutdown; finding it at start means the last run did not end cleanly. */
const runningMarker = join(coderraDir, "running");

/** The rootless container the agent's shell runs in on a server (server/box). */
const box = new PodmanBox({ script: boxScript, coderraDir });

const envBytes = (name: string) => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Disk and memory. On a server a nearly full disk refuses new work; on a phone it is only reported. */
const health = new Health({
	path: workspace,
	enforce: mode === "vps",
	limits: {
		diskWarnBytes: envBytes("CODERRA_DISK_WARN_BYTES") ?? DEFAULT_HEALTH_LIMITS.diskWarnBytes,
		diskMinBytes: envBytes("CODERRA_DISK_MIN_BYTES") ?? DEFAULT_HEALTH_LIMITS.diskMinBytes,
		memoryWarnBytes: envBytes("CODERRA_MEMORY_WARN_BYTES") ?? DEFAULT_HEALTH_LIMITS.memoryWarnBytes,
	},
	onChange: reportHealth,
});

/** Pushes to the phone when nobody is looking at the app (notify.ts). */
const notifier = new Notifier({
	config: () => integrations?.notifyConfig() ?? null,
	shouldSend: () => !hub.hasClient() || hub.clientInBackground(),
	log: (m) => log(m),
});

function reportHealth(c: HealthChange) {
	if (c.what === "disk") {
		if (c.to === "ok") {
			send({ type: "notice", message: `Disk space is back to normal (${humanBytes(c.freeBytes)} free).` });
			return;
		}
		const critical = c.to === "critical";
		send({
			type: "notice",
			message: critical
				? `The disk is almost full (${humanBytes(c.freeBytes)} free). New prompts and tasks are refused until space is freed.`
				: `Disk space is getting low (${humanBytes(c.freeBytes)} free).`,
		});
		void notifier.send("disk", critical ? "Disk is almost full" : "Disk space is low", { priority: critical ? 5 : 4, tags: ["warning"] });
	} else if (c.to === "high") {
		send({ type: "notice", message: `The host is using a lot of memory (${humanBytes(c.rssBytes)}).` });
		void notifier.send("memory", "Host memory is high", { priority: 3, tags: ["warning"] });
	}
}

/** A background run ended: tell the phone, unless the user stopped it themselves. */
function notifyRunFinished(run: { status: string }) {
	const titles: Record<string, [string, 1 | 2 | 3 | 4 | 5, string]> = {
		done: ["Task finished", 3, "white_check_mark"],
		error: ["Task failed", 4, "x"],
		blocked: ["Task needs you", 4, "raised_hand"],
		limit: ["Task hit its limit", 4, "hourglass"],
	};
	const t = titles[run.status];
	if (t) void notifier.send(`run_${run.status}`, t[0], { priority: t[1], tags: [t[2]] });
}

function log(...args: unknown[]) {
	process.stderr.write(`${args.map(String).join(" ")}\n`);
}

/** Drop cumulative snapshots from streaming updates, like pi's JSON mode. */
function wireEvent(event: AgentSessionEvent): object {
	if (event.type === "message_update") {
		const { message: _message, assistantMessageEvent, ...rest } = event as any;
		const { partial, ...delta } = assistantMessageEvent ?? {};
		// Tool-call deltas don't name their tool; lift id and name from the snapshot.
		const block = delta.type?.startsWith("toolcall_") ? partial?.content?.[delta.contentIndex] : undefined;
		if (block?.type === "toolCall") Object.assign(delta, { id: block.id, toolName: block.name });
		return { ...rest, assistantMessageEvent: delta };
	}
	return event;
}

// ---------------------------------------------------------------------------
// Sessions

function modelInfo(model: any) {
	if (!model || model.provider === "unknown") return null;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: !!model.reasoning,
		contextWindow: model.contextWindow ?? null,
		input: model.input ?? ["text"],
	};
}

function state() {
	const s = session!;
	return {
		model: modelInfo(s.model),
		thinkingLevel: s.thinkingLevel,
		thinkingLevels: s.getAvailableThinkingLevels(),
		isStreaming: s.isStreaming,
		sessionId: s.sessionId,
		sessionFile: s.sessionFile ?? null,
		sessionName: s.sessionName ?? null,
		cwd: s.sessionManager.getCwd(),
		billingNotice: billingNotice(),
		planMode: guard.planMode,
		approvalMode: guard.mode,
		// The chat stops in the middle of something and nothing is running. Why is not known (see interrupted.ts).
		interrupted: !s.isStreaming && endsUnfinished(s.sessionManager.getLeafEntry()),
	};
}

/** The guard for runs nobody is watching: risky commands and writes outside the project are refused, not asked about. */
function unattendedGuard(cwd: string): Guard {
	const g = new Guard({
		send: () => {},
		checkpoint: async (dir, label) => {
			await checkpoints.snapshot(dir, label);
		},
		cwd: () => cwd,
	});
	g.mode = "deny_risky";
	return g;
}

/** Every session (chat or background run) is built the same way. */
async function buildSession(sessionManager: SessionManager, opts: { interactive: boolean; tools?: string[]; child?: boolean; mcp?: boolean }) {
	const cwd = sessionManager.getCwd();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		// Approvals and plan mode only make sense with someone watching.
		// A person watching can approve things (and use plan mode). A background run cannot, so it gets a guard that
		// refuses what would have needed approval.
		extensionFactories: [{ name: "andropi", factory: opts.interactive ? guard.extension : unattendedGuard(cwd).extension, hidden: true }],
	});
	await resourceLoader.reload();
	// A sub-agent gets only what its role allows: no MCP servers unless it is a worker, and never `tasks` or `subagent`.
	const mcpTools = opts.mcp === false ? [] : mcp.toolDefinitions();
	const result = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		tools: [...(opts.tools ?? TOOLS), ...mcpTools.map((t) => t.name)],
		customTools: [
			...patchedTools(cwd, { autoResizeImages: settingsManager.getImageAutoResize() }),
			...webTools(() => integrations.searchKeys()),
			...(opts.child ? [] : [tasksTool((r) => send(r)), subagentTool(subagentDeps)]),
			...mcpTools,
		] as any,
	});
	// Some models send "None" or numbers-as-strings for tool arguments.
	installLenientTools(result.session.agent);
	return result;
}

let lastUserText = "";
/** A Continue is on its way into the chat (it may not be streaming yet). */
let continuing = false;
let fallbackTried = false;

async function openSession(sessionManager: SessionManager) {
	unsubscribe?.();
	guard.cancelAll();
	session?.dispose();
	const result = await buildSession(sessionManager, { interactive: true });
	session = result.session;
	unsubscribe = session.subscribe((event) => {
		send({ type: "event", event: wireEvent(event) });
		onSessionEvent(event);
	});
	if (result.modelFallbackMessage) send({ type: "notice", message: result.modelFallbackMessage });
	return state();
}

/** Hooks on the active chat: model fallback and "done" notifications. */
function onSessionEvent(event: AgentSessionEvent) {
	if (event.type === "message_end") {
		const m = (event as any).message;
		if (m?.role === "assistant" && m.stopReason === "error") void tryFallback(String(m.errorMessage ?? ""));
	}
	if (event.type === "agent_end" || (event as any).type === "agent_settled") {
		const text = session?.getLastAssistantText?.() ?? "";
		send({ type: "agent_done", sessionFile: session?.sessionFile ?? null, preview: text.slice(0, 200) });
		void notifier.send("agent_done", "Agent finished", { tags: ["white_check_mark"] });
	}
}

async function tryFallback(error: string) {
	const chain = integrations.settings.fallbackModels ?? [];
	if (!chain.length || fallbackTried || !session) return;
	if (!/rate|limit|quota|overload|429|5\d\d|unavailable|insufficient|credit|exceeded|timeout/i.test(error)) return;
	const current = `${session.model?.provider}/${session.model?.id}`;
	const next = chain.find((f) => `${f.provider}/${f.model}` !== current);
	const model = next && modelRuntime.getModel(next.provider, next.model);
	if (!model) return;
	fallbackTried = true;
	await session.setModel(model, { persist: false });
	send({ type: "notice", message: `Switched to ${model.name ?? model.id} after an error: ${error.slice(0, 120)}` });
	send({ type: "state", state: state() });
	session.prompt("Continue where you left off (the previous model failed).").catch(() => {});
}

/** Refuses new work once today's spend reaches the configured cap. */
function checkBudget() {
	const cap = integrations.settings.dailyBudget ?? 0;
	if (!cap) return;
	const today = new Date().toISOString().slice(0, 10);
	const spent = usageSummary(join(agentDir, "sessions"), 1)
		.filter((r) => r.day === today)
		.reduce((sum, r) => sum + r.cost, 0);
	if (spent >= cap) throw new Error(`Daily budget of $${cap.toFixed(2)} reached ($${spent.toFixed(2)} spent). Raise it in Settings → Usage.`);
}

/** Mirrors pi's interactive warning: subscription OAuth outside Claude's own apps bills extra usage. */
function billingNotice(): string | null {
	if (session?.model?.provider !== "anthropic" || !modelRuntime.isUsingOAuth("anthropic")) return null;
	if (settingsManager.getWarnings().anthropicExtraUsage === false) return null;
	return "Claude subscription sign-in bills third-party apps like this one per token from extra usage, not your plan limits. Manage it at claude.ai/settings/usage, or use an API key.";
}

/**
 * Switching chats ends the active session, and ending it stops whatever it is doing. While the agent works, the app
 * has to say that is meant (`force`); then the run is stopped first, so its end is written down before the session goes.
 */
async function leaveActiveSession(cmd: Command) {
	const s = session;
	if (!s?.isStreaming) return;
	if (cmd.force !== true) {
		throw Object.assign(new Error("The agent is still working in this chat. Switching now stops it. Wait for it to finish, or switch anyway."), { code: "busy" });
	}
	// A tool that ignores the stop signal must not keep the switch waiting forever.
	await Promise.race([s.abort(), new Promise((r) => setTimeout(r, 10_000).unref())]);
}

/** Rebuilds the active session so tool settings (shell, MCP tools) take effect. */
async function reopenSession() {
	const s = session!;
	if (s.isStreaming) throw new Error("Wait for the agent to finish first");
	const file = s.sessionFile;
	await openSession(file ? SessionManager.open(file) : SessionManager.create(s.sessionManager.getCwd()));
}

/** A headless session for the background runner. */
/** Sub-agents: at most two at a time (they share this process's memory), and what they cost counts toward the parent's job. */
const childCost = new Map<string, number>();
const subagentDeps: SubagentDeps = {
	slots: new Slots(Number(process.env.CODERRA_SUBAGENTS_MAX) || 2),
	preflight: async () => {
		await health.assertRoom();
		checkBudget();
	},
	recordCost: (parent, cost) => void childCost.set(parent, (childCost.get(parent) ?? 0) + cost),
	create: (o) => createChild(o),
};

/** The folder, inside a project's sessions, that holds its sub-agents' conversations. */
const SUBAGENT_SESSIONS = "subagents";

/** A session for a sub-agent: its own conversation (named after the job, so it can be found), tools by role, nobody to ask. */
async function createChild(o: { role: Role; cwd: string; model?: string; parentModel?: string; title: string }): Promise<ChildSession> {
	const find = (name: string) => {
		const at = name.indexOf("/");
		return at > 0 ? modelRuntime.getModel(name.slice(0, at), name.slice(at + 1)) : undefined;
	};
	const model = o.model ? find(o.model) : o.parentModel ? find(o.parentModel) : undefined;
	if (o.model && !model) throw new Error(`Unknown model "${o.model}". Write it as provider/model.`);

	// Kept in a folder of their own under the project's sessions: out of the chat list and of "the latest chat" (which
	// would open a child's conversation as the main chat), still counted by the usage summary, which walks every folder.
	const manager = SessionManager.create(o.cwd, join(SessionManager.create(o.cwd).getSessionDir(), SUBAGENT_SESSIONS));
	manager.appendSessionInfo(`↳ ${o.title}`);
	const tools = o.role === "explorer" ? EXPLORER_TOOLS : TOOLS.filter((t) => t !== "subagent" && t !== "tasks");
	const { session: cs } = await buildSession(manager, { interactive: false, tools, child: true, mcp: o.role === "worker" });
	try {
		if (model) await cs.setModel(model, { persist: false });
	} catch (e) {
		cs.dispose();
		throw e;
	}
	let error: string | undefined;
	let onTool: ((name: string, args: Record<string, unknown>) => void) | undefined;
	cs.subscribe((e) => {
		const m = (e as any).message;
		if (e.type === "tool_execution_start") onTool?.(e.toolName, (e.args ?? {}) as Record<string, unknown>);
		if (e.type === "message_end" && m?.role === "assistant") error = m.stopReason === "error" ? String(m.errorMessage ?? "error") : undefined;
	});
	return {
		sessionFile: cs.sessionFile,
		prompt: (text) => cs.prompt(text),
		lastText: () => cs.getLastAssistantText() ?? "",
		errorText: () => error,
		abort: () => cs.abort(),
		dispose: () => cs.dispose(),
		cost: () => cs.getSessionStats().cost,
		onTool: (cb) => void (onTool = cb),
	};
}

async function backgroundSession(cwd: string, sessionFile?: string): Promise<RunSession> {
	// A run picked up again after a restart reopens its own conversation instead of starting a new one.
	const manager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd || workspace);
	const { session: bg } = await buildSession(manager, { interactive: false });
	const where = manager.getCwd();
	let error: string | undefined;
	let aborted = false;
	const napping = cancellableSleep();
	bg.subscribe((e) => {
		const m = (e as any).message;
		// The last answer decides: pi's own retry may have recovered from an earlier failure.
		if (e.type === "message_end" && m?.role === "assistant") error = m.stopReason === "error" ? m.errorMessage : undefined;
	});

	/** After a temporary failure, move on to the next configured fallback model, if there is one. */
	let fallbackStep = 0;
	const switchModel = async () => {
		const chain = integrations.settings.fallbackModels ?? [];
		if (!chain.length) return;
		const current = `${bg.model?.provider}/${bg.model?.id}`;
		const candidates = chain.filter((f) => `${f.provider}/${f.model}` !== current);
		const next = candidates[fallbackStep++ % Math.max(candidates.length, 1)];
		const model = next && modelRuntime.getModel(next.provider, next.model);
		if (model) await bg.setModel(model, { persist: false }).catch(() => {});
	};

	return {
		sessionFile: bg.sessionFile,
		prompt: async (text) => {
			checkBudget();
			await health.assertRoom();
			await promptWithRetry(text, {
				prompt: (t) => bg.prompt(t),
				error: () => error,
				clearError: () => void (error = undefined),
				backoffMs: backoffFromEnv(process.env.CODERRA_RETRY_BACKOFF_MS),
				maxRetries: Number(process.env.CODERRA_RETRY_MAX) || 12,
				isAborted: () => aborted,
				sleep: napping.sleep,
				onRetry: async ({ attempt, waitMs, error: why }) => {
					log(`background run: temporary error, waiting ${Math.round(waitMs / 1000)}s before attempt ${attempt + 1}: ${why.slice(0, 120)}`);
					await switchModel();
				},
			});
		},
		lastText: () => bg.getLastAssistantText(),
		errorText: () => error,
		abort: async () => {
			aborted = true;
			napping.cancel();
			await bg.abort();
		},
		dispose: () => bg.dispose(),
		cost: () => bg.getSessionStats().cost + (childCost.get(bg.sessionManager.getSessionId()) ?? 0),
		checklist: () => latestChecklist(bg.sessionManager.getBranch()),
		runCommand: (command) => runShell(command, where),
		snapshot: async (label) => (await checkpoints.snapshot(where, label)) !== null,
	};
}

/** Runs a shell command the way the agent's own shell would (inside the container on a server), and returns how it ended. */
function runShell(command: string, cwd: string): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const shell = settingsManager.getShellPath() ?? (existsSync("/bin/bash") ? "/bin/bash" : existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh");
		const child = spawn(shell, ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const keep = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-20_000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: 127, output: String(e.message) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, output });
		});
	});
}

/** Keeps the environment notes current, unless the user has taken the file over. */
function ensureAgentsFile() {
	const path = join(agentDir, "AGENTS.md");
	if (existsSync(path)) {
		const current = readFileSync(path, "utf8");
		const ours = current.includes(AGENTS_MARKER) || LEGACY_STARTS.some((start) => current.startsWith(start));
		if (!ours) return;
	}
	writeFileSync(path, agentsFileText({ mode, workspace, box: mode === "vps" && existsSync(boxScript) && integrations?.settings?.containerShell !== false }));
}

// ---------------------------------------------------------------------------
// Login bridge: pi's AuthInteraction is forwarded to the app.

let nextAuthId = 1;
const pendingAuth = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

async function login(providerId: string, method: "api_key" | "oauth") {
	const controller = new AbortController();
	await modelRuntime.login(providerId, method, {
		signal: controller.signal,
		prompt: (prompt) =>
			new Promise<string>((resolve, reject) => {
				const authId = nextAuthId++;
				pendingAuth.set(authId, { resolve, reject });
				const { signal, ...rest } = prompt;
				signal?.addEventListener("abort", () => {
					pendingAuth.delete(authId);
					send({ type: "auth_dismiss", authId });
					reject(new Error("cancelled"));
				});
				send({ type: "auth_prompt", authId, provider: providerId, prompt: rest });
			}),
		notify: (event) => send({ type: "auth_event", provider: providerId, event }),
	});
}

async function providers() {
	const custom = new Set(readCustomProviderIds());
	const config = readModelsJson();
	const out = [];
	for (const p of modelRuntime.getProviders()) {
		const auth = p.auth as any;
		const entry = custom.has(p.id) ? config.providers[p.id] : undefined;
		out.push({
			id: p.id,
			name: p.name,
			configured: modelRuntime.hasConfiguredAuth(p.id),
			oauth: modelRuntime.isUsingOAuth(p.id),
			methods: [auth.apiKey?.login ? "api_key" : null, auth.oauth ? "oauth" : null].filter(Boolean),
			models: modelRuntime.getModels(p.id).length,
			custom: !!entry,
			baseUrl: entry?.baseUrl ?? null,
			customModel: entry?.models?.[0]?.id ?? null,
			customModels: entry?.models ?? [],
		});
	}
	// A managed provider the runtime failed to load (e.g. a hand-edited
	// models.json) is still listed, so the app can delete or fix it.
	const seen = new Set(out.map((o) => o.id));
	for (const id of custom) {
		if (seen.has(id)) continue;
		const entry = config.providers[id];
		if (!entry) continue;
		out.push({
			id,
			name: entry.name ?? id,
			configured: false,
			oauth: false,
			methods: [],
			models: entry.models?.length ?? 0,
			custom: true,
			baseUrl: entry.baseUrl ?? null,
			customModel: entry.models?.[0]?.id ?? null,
			customModels: entry.models ?? [],
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Custom providers: OpenAI-compatible endpoints added in
// Settings → Models & providers. Definitions live in pi's models.json (the
// format pi documents for compatible endpoints); a registry in the app state
// dir remembers which provider ids the app manages, so built-in providers
// and hand-written models.json overrides are never offered for deletion.

const modelsJsonPath = join(agentDir, "models.json");
const customProvidersPath = join(stateDir, "custom-providers.json");

function readModelsJson(): { providers: Record<string, any> } {
	try {
		const parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
			return { providers: parsed.providers };
		}
	} catch {
		// Missing or unreadable: start from an empty set.
	}
	return { providers: {} };
}

function writeModelsJson(config: { providers: Record<string, any> }) {
	writeFileSync(modelsJsonPath, `${JSON.stringify(config, null, 2)}\n`);
}

function readCustomProviderIds(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(customProvidersPath, "utf8"));
		if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		// None registered yet.
	}
	return [];
}

function writeCustomProviderIds(ids: string[]) {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(customProvidersPath, `${JSON.stringify(ids, null, 2)}\n`);
}

/** Reloads models.json for one provider after a save or delete. */
async function refreshProvider(id: string) {
	// Scoped, offline refresh: a full refresh re-fetches every provider's
	// catalog over the network and can block this command for minutes.
	await modelRuntime.refresh({ providers: [id], allowNetwork: false });
}

type CustomModelInput = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	vision?: boolean;
};

function positiveInt(v: any): number | undefined {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Normalizes one model descriptor (from the app, or a /models entry already
 * mapped by fetchCustomProviderModels) into a models.json model entry. Only
 * metadata pi understands is carried over; ids are the only required part. */
function customModelEntry(input: any): Record<string, any> | null {
	const raw = typeof input === "string" ? { id: input } : input;
	if (!raw || typeof raw !== "object") return null;
	const id = String(raw.id ?? "").trim();
	if (!id) return null;
	const entry: Record<string, any> = { id };
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (name && name !== id) entry.name = name;
	if (raw.reasoning === true) entry.reasoning = true;
	if (raw.vision === true || (Array.isArray(raw.input) && raw.input.includes("image"))) {
		entry.input = ["text", "image"];
	}
	const contextWindow = positiveInt(raw.contextWindow);
	if (contextWindow) entry.contextWindow = contextWindow;
	const maxTokens = positiveInt(raw.maxTokens);
	if (maxTokens) entry.maxTokens = maxTokens;
	return entry;
}

/** The model list for a save: cmd.models (many) or legacy cmd.model (one). */
function customModelEntries(cmd: Command): Record<string, any>[] {
	const rawList = Array.isArray(cmd.models) ? cmd.models : cmd.model != null ? [cmd.model] : [];
	const seen = new Set<string>();
	const out: Record<string, any>[] = [];
	for (const item of rawList) {
		const entry = customModelEntry(item);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push(entry);
		if (out.length >= 500) break;
	}
	return out;
}

async function saveCustomProvider(cmd: Command) {
	const name = String(cmd.name ?? "").trim();
	const apiKey = String(cmd.apiKey ?? "").trim();
	const rawBaseUrl = String(cmd.baseUrl ?? "").trim();
	const id = String(cmd.provider ?? "").trim().toLowerCase();
	if (!name) throw new Error("Provider name is empty");
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		throw new Error("Provider name must start with a letter or digit and use only letters, digits, - or _");
	}
	const models = customModelEntries(cmd);
	if (models.length === 0) throw new Error("Add at least one model ID");
	let url: URL;
	try {
		url = new URL(rawBaseUrl);
	} catch {
		throw new Error("Base URL is not a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must start with http:// or https://");
	const baseUrl = rawBaseUrl.replace(/\/+$/, "");

	const registry = readCustomProviderIds();
	const isOurs = registry.includes(id);
	if (!isOurs && modelRuntime.getProviders().some((p) => p.id === id)) {
		throw new Error(`"${id}" is already used by a built-in provider. Choose another name.`);
	}
	const config = readModelsJson();
	const existing = config.providers[id];
	// Editing without a new key keeps the stored one.
	const key = apiKey || (typeof existing?.apiKey === "string" ? existing.apiKey : "");
	if (!key) throw new Error("API key is empty");
	config.providers[id] = {
		name,
		baseUrl,
		api: "openai-completions",
		apiKey: key,
		models,
	};
	writeModelsJson(config);
	if (!isOurs) writeCustomProviderIds([...registry, id]);
	await refreshProvider(id);
	return providers();
}

/** Maps one entry of an OpenAI-style GET /models response to the descriptor
 * shape the app passes back on save. Gateways expose the metadata under
 * different keys (see e.g. GripHub's response), so accept the common
 * spellings and keep only what pi can use. */
function fetchedModel(raw: any): CustomModelInput | null {
	if (!raw || typeof raw !== "object") return null;
	const id = String(raw.id ?? "").trim();
	if (!id) return null;
	const caps = raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {};
	const out: CustomModelInput = { id };
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (name && name !== id) out.name = name;
	const contextWindow = positiveInt(raw.context_window ?? raw.contextWindow ?? caps.contextWindow ?? caps.context_window);
	if (contextWindow) out.contextWindow = contextWindow;
	const maxTokens = positiveInt(raw.max_output_tokens ?? raw.maxTokens ?? caps.maxOutput ?? caps.max_output_tokens);
	if (maxTokens) out.maxTokens = maxTokens;
	if (caps.reasoning === true || raw.reasoning === true) out.reasoning = true;
	if (caps.vision === true) out.vision = true;
	return out;
}

/** Fetches the model catalog of an OpenAI-compatible endpoint so the app can
 * offer it as a checklist instead of making the user type every model ID.
 * A blank key falls back to the one stored for cmd.provider (edit flow). */
async function fetchCustomProviderModels(cmd: Command) {
	const rawBaseUrl = String(cmd.baseUrl ?? "").trim();
	let url: URL;
	try {
		url = new URL(rawBaseUrl);
	} catch {
		throw new Error("Base URL is not a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must start with http:// or https://");
	const baseUrl = rawBaseUrl.replace(/\/+$/, "");
	let apiKey = String(cmd.apiKey ?? "").trim();
	if (!apiKey && cmd.provider) {
		const existing = readModelsJson().providers[String(cmd.provider)];
		if (typeof existing?.apiKey === "string") apiKey = existing.apiKey;
	}
	let res: Response;
	try {
		res = await fetch(`${baseUrl}/models`, {
			headers: {
				Accept: "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			signal: AbortSignal.timeout(20000),
		});
	} catch (e: any) {
		throw new Error(`Could not reach ${baseUrl}/models: ${e?.cause?.message ?? e?.message ?? e}`);
	}
	if (!res.ok) throw new Error(`Model list request failed: HTTP ${res.status}`);
	const body: any = await res.json().catch(() => null);
	const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
	if (!list) throw new Error("The endpoint did not return a model list");
	const seen = new Set<string>();
	const models: CustomModelInput[] = [];
	for (const raw of list) {
		const m = fetchedModel(raw);
		if (!m || seen.has(m.id)) continue;
		seen.add(m.id);
		models.push(m);
	}
	if (models.length === 0) throw new Error("The endpoint returned no models");
	return { models };
}

/** Catalog of the built-in free provider, as listed by its /models endpoint
 * when the seed was written. glm-4.7 comes first: it is the model the
 * gateway itself recommends and the one verified to answer. The list is a
 * starting point — the user can refresh it with Fetch in the edit form. */
const ZELAI_FREE_MODELS = [
	"glm-4.7",
	"big-pickle",
	"beam-free",
	"mimo-v2.6-flash-free",
	"nemotron-3.5-super-vl-free",
	"nemotron-3.5-lightning-free",
	"longcat-2.5-preview-free",
	"deepseek-v4.1-flash-free",
	"glm-5.3-flash-free",
	"space-bunny-free",
	"gemini-1.5-pro-free",
	"minimax-m2.7-free",
	"ciora-coding-free",
	"ciora-ai-free",
	"ciora-vision-free",
	"z-image-turbo",
	"qwen2.5-1.5b-instruct-free",
	"phi-3.5-mini-free",
	"smollm2-1.7b-instruct-free",
	"tinyllama-1.1b-free",
];

const seededFreeProvidersPath = join(stateDir, "seeded-free-providers.json");

function readSeededFreeProviders(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(seededFreeProvidersPath, "utf8"));
		if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		// Nothing seeded yet.
	}
	return [];
}

/** Seeds the built-in free provider (Zelai's keyless OpenAI-compatible
 * gateway) into models.json exactly like a user-added custom provider, so
 * it can be edited or deleted from Settings. Seeding happens once: the
 * marker file keeps a deleted provider deleted. Must run before
 * ModelRuntime.create() so the runtime picks the provider up. */
function seedFreeProviders() {
	const seeded = readSeededFreeProviders();
	if (seeded.includes("zelai-free")) return;
	const config = readModelsJson();
	if (!config.providers["zelai-free"]) {
		config.providers["zelai-free"] = {
			name: "Zelai (Free)",
			baseUrl: "https://ai.zelai.qzz.io/v1",
			api: "openai-completions",
			// The gateway needs no account key, but pi refuses to use a
			// provider that has none — this placeholder is simply ignored
			// by the gateway.
			apiKey: "zelai",
			models: ZELAI_FREE_MODELS.map((id) => ({ id })),
		};
		writeModelsJson(config);
		const registry = readCustomProviderIds();
		if (!registry.includes("zelai-free")) writeCustomProviderIds([...registry, "zelai-free"]);
	}
	writeFileSync(seededFreeProvidersPath, `${JSON.stringify([...seeded, "zelai-free"], null, 2)}\n`);
}

async function deleteCustomProvider(cmd: Command) {
	const id = String(cmd.provider ?? "");
	const registry = readCustomProviderIds();
	if (!registry.includes(id)) throw new Error("That is not a custom provider");
	const config = readModelsJson();
	delete config.providers[id];
	writeModelsJson(config);
	writeCustomProviderIds(registry.filter((x) => x !== id));
	await modelRuntime.logout(id).catch(() => {});
	await refreshProvider(id);
	return providers();
}

// ---------------------------------------------------------------------------
// Backups

function backupTarget() {
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
	const shared = "/storage/emulated/0/Download";
	const dir = existsSync(shared) ? join(shared, "CoderRa") : join(workspace, "backups");
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".probe"), "");
		unlinkSync(join(dir, ".probe"));
		return join(dir, `coderra-backup-${stamp}.zip`);
	} catch {
		mkdirSync(join(workspace, "backups"), { recursive: true });
		return join(workspace, "backups", `coderra-backup-${stamp}.zip`);
	}
}

/** Changing the box kills whatever is running in it. Refuse while the agent is, unless the app says it is meant. */
async function guardBoxWork(cmd: Command) {
	if (mode !== "vps") throw new Error("Only a server has a box");
	if (cmd.force === true) return;
	const working = session?.isStreaming ? "The agent is working in the box right now." : runner?.summary().running ? "A background task is running in the box." : null;
	if (working) throw Object.assign(new Error(`${working} Stop it first, or do it anyway.`), { code: "busy" });
}

/** Backups are written and read in pieces (backup.ts), so a big workspace neither fills memory nor freezes the host. */
async function backupCommand(includeWorkspace: boolean) {
	const sources = { agentDir, workspace, includeWorkspace };
	const r = await createBackup(sources, backupTarget());
	return { path: r.path, files: r.files, bytes: r.bytes, left: r.left.slice(0, 20), leftCount: r.left.length };
}

async function restoreCommand(path: string) {
	const r = await restoreBackup(String(path), { agent: agentDir, workspace });
	return { restored: r.restored, skipped: r.skipped.slice(0, 20), skippedCount: r.skipped.length };
}

// ---------------------------------------------------------------------------
// Commands

async function handle(cmd: Command): Promise<unknown> {
	// File access for the app does not depend on the chat session (fs.ts).
	if (isFsCommand(cmd.type)) return runFsCommand(fsService, cmd);
	// Web pages from the project folder, served on this machine's loopback for the app to reach (preview.ts).
	if (cmd.type === "preview_serve") return preview.serve(cmd.dir);
	if (cmd.type === "preview_stop") return { stopped: preview.stop(Number(cmd.port)) };
	const s = session!;
	const cwd = (cmd.dir as string | undefined) ?? s.sessionManager.getCwd();
	switch (cmd.type) {
		case "hello":
			return {
				version: VERSION,
				node: process.version,
				agentDir,
				workspace,
				tools: s.getActiveToolNames(),
				transport: listenPath ? "socket" : "stdio",
				protocol: PROTOCOL,
				...state(),
			};
		case "state":
			return state();

		case "prompt": {
			checkBudget();
			await health.assertRoom();
			lastUserText = cmd.text;
			fallbackTried = false;
			// Plan mode: ask for a plan first; tools that change things are blocked (guard.ts).
			const text = guard.planMode
				? `${cmd.text}\n\n[Plan mode] Investigate as needed, then reply with a numbered plan only. Do not change files or run commands that modify anything until I approve.`
				: cmd.text;
			// Don't await the run; progress arrives as events.
			s.prompt(text, {
				images: cmd.images,
				streamingBehavior: s.isStreaming ? (cmd.behavior ?? "followUp") : undefined,
			}).catch((e) => send({ type: "error", message: String(e?.message ?? e) }));
			return null;
		}
		case "steer":
			await s.steer(cmd.text);
			return null;
		case "abort":
			guard.cancelAll();
			await s.abort();
			return null;
		case "session_stats":
			return { ...s.getSessionStats(), context: s.getContextUsage() ?? null };

		// Approvals and plan mode (guard.ts).
		case "approval_reply":
			guard.reply(cmd.approvalId, !!cmd.allow, !!cmd.always, cmd.key);
			return null;
		// The checklist as of the current point of the conversation (agent/src/tasks.ts).
		case "tasks_get":
			return tasksRecord(s.sessionId, latestChecklist(s.sessionManager.getBranch()));
		case "approvals_pending":
			return guard.pendingApprovals();
		case "host_restart":
			if (!listenPath) throw new Error("Restarting is only available when the host runs as a daemon");
			return restartGate.request(cmd.whenIdle !== false);
		case "plan_mode":
			guard.planMode = !!cmd.on;
			return state();
		case "plan_approve":
			guard.planMode = false;
			s.prompt(cmd.text || "The plan is approved. Write it down as a checklist with the tasks tool, then carry it out step by step.").catch((e) =>
				send({ type: "error", message: String(e?.message ?? e) }),
			);
			return state();

		// Editing and forking the conversation.
		case "fork_points":
			return s.getUserMessagesForForking();
		case "edit_message": {
			// Moves back to just before that message; the text returns for editing.
			const r = await s.navigateTree(cmd.entryId, {});
			return { text: r.editorText ?? "", cancelled: r.cancelled };
		}
		case "fork_session": {
			const source = s.sessionFile;
			if (!source) throw new Error("Nothing to fork yet");
			await leaveActiveSession(cmd);
			await openSession(SessionManager.forkFrom(source, s.sessionManager.getCwd()));
			const r = cmd.entryId ? await session!.navigateTree(cmd.entryId, {}) : { editorText: "" };
			return { ...state(), text: r.editorText ?? "" };
		}

		case "providers":
			return providers();
		case "models":
			return (await modelRuntime.getAvailable(cmd.provider)).map(modelInfo);
		case "set_model": {
			const model = modelRuntime.getModel(cmd.provider, cmd.model);
			if (!model) throw new Error(`Unknown model ${cmd.provider}/${cmd.model}`);
			await s.setModel(model, { persist: true });
			return state();
		}
		case "set_thinking":
			s.setThinkingLevel(cmd.level, { persist: true });
			return state();

		case "login":
			await login(cmd.provider, cmd.method ?? "api_key");
			return providers();
		case "auth_reply": {
			const pending = pendingAuth.get(cmd.authId);
			pendingAuth.delete(cmd.authId);
			if (cmd.cancel) pending?.reject(new Error("cancelled"));
			else pending?.resolve(String(cmd.value ?? ""));
			return null;
		}
		case "logout":
			await modelRuntime.logout(cmd.provider);
			return providers();
		case "custom_provider_save":
			return saveCustomProvider(cmd);
		case "custom_provider_fetch_models":
			return fetchCustomProviderModels(cmd);
		case "custom_provider_delete":
			return deleteCustomProvider(cmd);

		case "new_session":
			await leaveActiveSession(cmd);
			return openSession(SessionManager.create(cmd.cwd ?? workspace));
		case "sessions":
			// Sub-agents from before they had a folder of their own are recognised by their name.
			return (await SessionManager.listAll()).filter((info) => !info.name?.startsWith("↳ ")).map((info) => ({
				path: info.path,
				id: info.id,
				cwd: info.cwd,
				name: info.name ?? null,
				modified: info.modified.getTime(),
				messageCount: info.messageCount,
				firstMessage: info.firstMessage,
			}));
		case "open_session":
			// The chat that is already open stays as it is: opening it again would only stop it.
			if (s.sessionFile && resolve(String(cmd.path)) === resolve(s.sessionFile)) return state();
			await leaveActiveSession(cmd);
			return openSession(SessionManager.open(cmd.path));
		case "rename_session": {
			const name = String(cmd.name ?? "").trim();
			if (!name) throw new Error("Name is empty");
			if (cmd.path === s.sessionFile) s.setSessionName(name);
			else SessionManager.open(cmd.path).appendSessionInfo(name);
			return null;
		}
		case "delete_session":
			if (cmd.path === s.sessionFile) throw new Error("Switch to another session before deleting this one");
			unlinkSync(cmd.path);
			return null;
		case "messages":
			return s.messages;

		// Accounts, repositories, SSH and deploys (integrations.ts).
		case "integrations":
			return integrations.summary();
		case "app_update_check":
			return checkAppUpdate(agentDir, (p) => integrations.githubApi(p), !!(cmd as any).force, {
				build: (cmd as any).currentBuild === undefined || !Number.isFinite(Number((cmd as any).currentBuild)) ? undefined : Number((cmd as any).currentBuild),
				version: typeof (cmd as any).currentVersion === "string" ? (cmd as any).currentVersion : undefined,
				abi: typeof (cmd as any).abi === "string" ? (cmd as any).abi : undefined,
			});
		case "app_update_download":
			return startAppUpdateDownload(
				agentDir,
				(p) => integrations.githubApi(p),
				(p, init) => integrations.githubRaw(p, init),
				typeof (cmd as any).abi === "string" ? (cmd as any).abi : undefined,
			);
		case "app_update_status":
			return appUpdateDownloadStatus(String((cmd as any).downloadId ?? ""));
		case "github_login":
			return integrations.githubLogin(cmd.token);
		case "github_device_start":
			return integrations.githubDeviceStart();
		case "github_device_poll":
			return integrations.githubDevicePoll(cmd.deviceCode);
		case "github_logout":
			return integrations.githubLogout();
		case "github_repos":
			return integrations.repos();
		case "git_clone":
			return integrations.clone(cmd.repo, taskLog(cmd));
		case "projects":
			return integrations.projects();
		case "ssh_key":
			return integrations.sshKey();
		case "ssh_host_save":
			return integrations.saveSshHost(cmd.host);
		case "ssh_host_delete":
			return integrations.deleteSshHost(cmd.hostId);
		case "ssh_test":
			return integrations.sshTest(cmd.hostId, taskLog(cmd));
		case "vercel_login":
			return integrations.vercelLogin(cmd.token);
		case "vercel_logout":
			return integrations.vercelLogout();
		case "ci_watch":
			return integrations.watchProject(cwd, taskLog(cmd));
		case "deploy":
			return integrations.deploy(cmd.target, cwd, cmd.options ?? {}, taskLog(cmd));

		// Git for the project folder (gitops.ts).
		case "git_status":
			return gitops.status(cwd);
		case "git_diff":
			return gitops.diff(cwd, cmd.file, !!cmd.staged);
		case "git_stage":
			await gitops.stage(cwd, cmd.paths ?? "all");
			return gitops.status(cwd);
		case "git_unstage":
			await gitops.unstage(cwd, cmd.paths ?? "all");
			return gitops.status(cwd);
		case "git_discard":
			await gitops.discard(cwd, cmd.paths ?? []);
			return gitops.status(cwd);
		case "git_commit":
			return { commit: await gitops.commit(cwd, String(cmd.message ?? "").trim() || "Update", !!cmd.all) };
		case "git_log":
			return gitops.log(cwd, cmd.limit ?? 40);
		case "git_branches":
			return gitops.branches(cwd);
		case "git_checkout":
			await gitops.checkout(cwd, cmd.branch, !!cmd.create);
			return gitops.status(cwd);
		case "git_pull":
			await gitops.pull(cwd, taskLog(cmd));
			return gitops.status(cwd);
		case "git_push":
			await gitops.push(cwd, taskLog(cmd));
			return gitops.status(cwd);
		case "github_pr_create": {
			const st = await gitops.status(cwd);
			const slug = st.repo ? gitops.githubSlug(st.remote) : null;
			if (!st.repo || !slug) throw new Error("This folder has no GitHub remote");
			if (st.ahead > 0 || !st.upstream) await gitops.push(cwd, () => {});
			const repo = await integrations.githubApi(`/repos/${slug}`);
			const pr = await integrations.githubApi(`/repos/${slug}/pulls`, {
				method: "POST",
				body: JSON.stringify({ title: cmd.title, body: cmd.body ?? "", head: st.branch, base: cmd.base || repo.default_branch }),
			});
			return { url: pr.html_url, number: pr.number };
		}
		case "github_issues": {
			const st = await gitops.status(cwd);
			const slug = cmd.repo ?? (st.repo ? gitops.githubSlug(st.remote) : null);
			if (!slug) throw new Error("This folder has no GitHub remote");
			const list = await integrations.githubApi(`/repos/${slug}/issues?state=${cmd.state ?? "open"}&per_page=50`);
			return {
				repo: slug,
				issues: (list as any[]).map((i) => ({
					number: i.number,
					title: i.title,
					body: i.body ?? "",
					url: i.html_url,
					author: i.user?.login,
					labels: (i.labels ?? []).map((l: any) => l.name),
					comments: i.comments,
					isPr: !!i.pull_request,
					updatedAt: Date.parse(i.updated_at),
				})),
			};
		}

		// Checkpoints (checkpoints.ts).
		case "checkpoints":
			return checkpoints.list(cwd);
		case "checkpoint_create":
			return checkpoints.snapshot(cwd, cmd.label || "Manual checkpoint");
		case "checkpoint_diff":
			return checkpoints.diff(cwd, cmd.checkpoint, cmd.file);
		case "checkpoint_restore":
			if (s.isStreaming) throw new Error("Stop the agent before restoring");
			return checkpoints.restore(cwd, cmd.checkpoint);

		// Project tools (workbench.ts).
		case "search":
			return search(cwd, String(cmd.query ?? ""), { regex: !!cmd.regex, caseSensitive: !!cmd.caseSensitive, glob: cmd.glob });
		case "db_tables":
			return dbTables(cmd.path);
		case "db_query":
			return dbQuery(cmd.path, String(cmd.sql ?? ""), cmd.limit ?? 200);
		case "tests_detect":
			return detectTests(cwd);
		case "tunnel_start":
			return {
				url: await tunnels.start(Number(cmd.port), (u) => send({ type: "tunnel", ...u })),
			};
		case "tunnel_stop":
			tunnels.stop(Number(cmd.port));
			return tunnels.list();
		case "tunnels":
			return tunnels.list();
		case "usage":
			return usageSummary(join(agentDir, "sessions"), cmd.days ?? 30);

		// Prompt templates: slash commands pi expands.
		case "templates":
			return templates.list();
		case "template_save": {
			const name = templates.save(cmd.name, cmd.description ?? "", cmd.body ?? "", cmd.argumentHint);
			await s.reload();
			return { name, templates: templates.list() };
		}
		case "template_delete":
			templates.remove(cmd.name);
			await s.reload();
			return templates.list();
		case "slash_commands":
			return {
				templates: templates.list().map((t) => ({ name: t.name, description: t.description, hint: t.argumentHint })),
				skills: skills.list().map((k) => ({ name: `skill:${k.name}`, description: k.description, hint: null })),
			};

		// Background runs, queue and schedules (runs.ts).
		case "runs":
			return runner.summary();
		case "run_enqueue":
			checkBudget();
			await health.assertRoom();
			return runner.enqueue(String(cmd.prompt ?? ""), cwd, cmd.title, "queue", cmd.task);
		// Pick a chat up again that stopped before it finished. Only then, and only once: a second tap, another device or
		// a retry must not send it again, nor into a run that is going.
		case "continue_session":
			if (s.isStreaming || continuing) throw Object.assign(new Error("The agent is already working."), { code: "busy" });
			if (!endsUnfinished(s.sessionManager.getLeafEntry())) return state();
			continuing = true;
			s.prompt(CONTINUE_CHAT)
				.catch((e) => send({ type: "error", message: String(e?.message ?? e) }))
				.finally(() => void (continuing = false));
			return state();
		// Disk, memory, and what is running: for the app's server screen.
		case "health": {
			const snap = await health.check();
			const runs = runner.summary();
			return {
				...snap,
				mode,
				transport: listenPath ? "socket" : "stdio",
				epoch: hub.epoch,
				uptimeSec: Math.round(process.uptime()),
				node: process.version,
				runs: { running: runs.running, queued: runs.runs.filter((r) => r.status === "queued").length },
				clientInBackground: hub.clientInBackground(),
			};
		}
		case "run_cancel":
			await runner.cancel(cmd.runId);
			return runner.summary();
		case "runs_clear":
			runner.clearFinished();
			return runner.summary();
		case "runs_concurrency":
			runner.setConcurrency(cmd.n);
			return runner.summary();
		case "schedule_save":
			runner.saveSchedule({ ...cmd.schedule, cwd: cmd.schedule?.cwd || cwd });
			return runner.summary();
		case "schedule_delete":
			runner.deleteSchedule(cmd.scheduleId);
			return runner.summary();
		case "schedule_run":
			runner.runScheduleNow(cmd.scheduleId);
			return runner.summary();

		// MCP servers (mcp.ts). Tools refresh on the next session rebuild.
		case "mcp_servers":
			return mcp.summary();
		case "mcp_save": {
			const out = await mcp.upsert(cmd.server ?? {});
			if (!s.isStreaming) await reopenSession();
			return out;
		}
		case "mcp_delete": {
			const out = await mcp.remove(cmd.serverId);
			if (!s.isStreaming) await reopenSession();
			return out;
		}

		// Backups.
		case "backup_estimate":
			return estimateBackup({ agentDir, workspace, includeWorkspace: !!cmd.includeWorkspace });
		case "backup_create":
			return backupCommand(!!cmd.includeWorkspace);
		case "backup_restore":
			return restoreCommand(cmd.path);

		// Linux container. On the phone: container.ts (proot). On a server: the rootless Podman box (podmanbox.ts), which the
		// setup script builds; the same commands serve both, so the screens do not need to know which one they talk to.
		case "container_status":
			return mode === "vps" ? box.status(settingsManager.getShellPath()) : container.status(settingsManager.getShellPath());
		case "container_install": {
			if (mode === "vps") {
				// "Install" on a server means building the image again.
				await guardBoxWork(cmd);
				await box.rebuildImage(taskLog(cmd));
				return box.status(settingsManager.getShellPath());
			}
			await container.install(cmd.distro as Distro, taskLog(cmd), integrations.settings.dns);
			// On by default once installed, unless the user turned it off before.
			if (integrations.settings.containerShell !== false) {
				settingsManager.setShellPath(container.shellPath);
				await settingsManager.flush();
				await reopenSession().catch(() => {});
			}
			return container.status(settingsManager.getShellPath());
		}
		case "container_remove":
			if (mode === "vps") {
				// "Remove" on a server throws the container away; the image and the box's home stay, and the next command makes a new one.
				await guardBoxWork(cmd);
				await box.reset();
				return box.status(settingsManager.getShellPath());
			}
			if (settingsManager.getShellPath() === container.shellPath) settingsManager.setShellPath(undefined);
			container.remove();
			await reopenSession();
			return container.status(settingsManager.getShellPath());
		case "container_enable":
			if (mode === "vps") {
				if (cmd.on && !box.available) throw new Error("There is no box on this server");
				settingsManager.setShellPath(cmd.on ? boxScript : undefined);
				integrations.updateSettings({ containerShell: !!cmd.on });
				ensureAgentsFile(); // the notes tell the agent where its commands run
				await settingsManager.flush();
				await reopenSession();
				return box.status(settingsManager.getShellPath());
			}
			if (cmd.on && !container.status(undefined).installed) throw new Error("Install the container first");
			settingsManager.setShellPath(cmd.on ? container.shellPath : undefined);
			integrations.updateSettings({ containerShell: !!cmd.on });
			await settingsManager.flush();
			await reopenSession();
			return container.status(settingsManager.getShellPath());
		// Server only: the box.
		case "box_check":
			return box.check();
		case "box_stop":
			await guardBoxWork(cmd);
			await box.stop();
			return box.status(settingsManager.getShellPath());
		case "box_wipe_home":
			await guardBoxWork(cmd);
			return { ...(await box.wipeHome()), status: await box.status(settingsManager.getShellPath()) };

		// App settings: DNS, search keys, approvals, fallbacks, budget.
		case "settings_get":
			return integrations.publicSettings();
		case "settings_set": {
			const out = integrations.updateSettings(cmd.settings ?? {});
			container.setNameservers(integrations.settings.dns);
			guard.mode = integrations.settings.approvalMode ?? "ask_risky";
			return out;
		}

		// Agent skills (skills.ts). pi rescans them on reload.
		case "skills_list":
			return skills.list();
		case "skills_search":
			return skills.search(cmd.query ?? "");
		case "skills_browse":
			return skills.browse(cmd.spec);
		case "skills_install": {
			const added = await skills.install(cmd.spec, taskLog(cmd));
			await s.reload();
			return added;
		}
		case "skills_remove":
			skills.remove(cmd.path);
			await s.reload();
			return skills.list();

		default:
			throw new Error(`Unknown command: ${cmd.type}`);
	}
}

/** Streams a long command's output to the app as `task` records. */
function taskLog(cmd: Command): Log {
	const taskId = cmd.taskId ?? cmd.id;
	const log: Log = (line: string) => send({ type: "task", taskId, line });
	log.ci = (ci) => send({ type: "task", taskId, ci });
	return log;
}

/** Nothing is in flight: no reply being written, no queued or running background run, no approval waiting. */
function isIdle(): boolean {
	const runs = runner?.summary();
	return !session?.isStreaming && guard.pendingApprovals().length === 0 && !runs?.running && !runs?.runs.some((r) => r.status === "queued");
}

let shuttingDown = false;
function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	tunnels.stopAll();
	runner?.dispose();
	void mcp?.dispose();
	session?.dispose();
	hub.close();
	health.stop();
	preview?.stopAll();
	if (listenPath) {
		rmSync(listenPath, { force: true });
		rmSync(runningMarker, { force: true });
	}
	process.exit(code);
}

const restartGate = new RestartGate({ isIdle, exit: () => shutdown(0) });

// ---------------------------------------------------------------------------
// Startup

async function main() {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	ensureAgentsFile();

	// Route every lookup through DNS-over-HTTPS (configurable in settings).
	installDohLookup();
	integrations = new Integrations(agentDir, workspace);
	guard.mode = integrations.settings.approvalMode ?? "ask_risky";
	skills = new Skills(agentDir, join(fileURLToPath(new URL(".", import.meta.url)), "skills"), () => process.env.GITHUB_TOKEN);
	skills.seed();
	templates = new Templates(agentDir);
	templates.seed(join(stateDir, "seeded-templates.json"));
	checkpoints = new Checkpoints(join(stateDir, "checkpoints"));
	// What the app may browse and edit: the workspace, plus read-only views of installed skills and downloaded updates.
	preview = new Preview({ roots: [workspace], idleMs: Number(process.env.CODERRA_PREVIEW_IDLE_MS) || undefined });
	fsService = new Fs([
		{ path: workspace },
		{ path: join(agentDir, "skills"), readOnly: true },
		{ path: join(agentDir, "updates"), readOnly: true },
	]);
	container = new Container(process.env.ANDROPI_FILES ?? join(agentDir, "..", "..", ".."));
	mcp = new Mcp(join(stateDir, "mcp.json"), () => send({ type: "mcp", servers: mcp.summary() }));
	// The built-in free provider must be in models.json before the runtime
	// loads it; a seed failure must never block startup.
	try {
		seedFreeProviders();
	} catch (e) {
		log("free provider seed failed:", e);
	}
	modelRuntime = await ModelRuntime.create();
	settingsManager = SettingsManager.create(workspace, agentDir);
	// Linux container is the agent's shell by default once installed.
	if (
		container.status(undefined).installed &&
		integrations.settings.containerShell !== false &&
		settingsManager.getShellPath() !== container.shellPath
	) {
		settingsManager.setShellPath(container.shellPath);
		await settingsManager.flush();
	}
	// On a server, bash runs inside the rootless container once it has been set up (server/box/box), unless the user
	// turned that off. If the launcher went away, stop pointing at it.
	if (mode === "vps") {
		const shell = settingsManager.getShellPath();
		if (existsSync(boxScript) && integrations.settings.containerShell !== false && shell !== boxScript) {
			settingsManager.setShellPath(boxScript);
			await settingsManager.flush();
		} else if (shell === boxScript && !existsSync(boxScript)) {
			settingsManager.setShellPath(undefined);
			await settingsManager.flush();
		}
	}
	await openSession(SessionManager.continueRecent(workspace));
	runner = new Runner(
		join(stateDir, "runs.json"),
		backgroundSession,
		(record) => {
			send(record);
			if ((record as { type?: string }).type === "run_finished") notifyRunFinished((record as { run: { status: string } }).run);
		},
		(p) => integrations.githubApi(p),
		{
			// Before each round of a long task: stop if the disk is full or the daily budget is spent.
			preflight: async () => {
				await health.assertRoom();
				checkBudget();
			},
		},
	);

	// Starter skills and MCP connections come up in the background; the chat
	// session is rebuilt afterwards (when idle) so it sees them.
	void Promise.allSettled([skills.installStarter((line) => log("skills:", line)), mcp.connectAll()]).then(() => {
		if (session && !session.isStreaming) return reopenSession().catch(() => {});
	});

	// A daemon that was killed leaves its marker behind; finding it means the last run did not end cleanly.
	if (listenPath) {
		mkdirSync(coderraDir, { recursive: true, mode: 0o700 });
		if (existsSync(runningMarker)) {
			send({ type: "notice", message: "The host was restarted unexpectedly (it was stopped without shutting down)." });
			void notifier.send("restarted", "Host restarted unexpectedly", { priority: 4, tags: ["warning"] });
		}
		writeFileSync(runningMarker, `${process.pid} ${new Date().toISOString()}\n`, { mode: 0o600 });
	}
	if (session && endsUnfinished(session.sessionManager.getLeafEntry())) {
		send({ type: "notice", message: "The last request was cut off before it finished. Tell the agent to continue, or press Continue." });
	}
	health.start();
	// While a long task runs, say so now and then, so silence from the phone's side means "nothing to report" and not "dead".
	const beat = setInterval(() => {
		if (runner.runningTasks().length > 0) void notifier.send("heartbeat", "Task still running", { priority: 2, tags: ["hourglass_flowing_sand"] });
	}, Number(process.env.CODERRA_HEARTBEAT_MS) || 6 * 3_600_000);
	beat.unref();

	const readyRecord = { type: "ready", version: VERSION };
	if (listenPath) {
		// Listen last: a client that connects now finds everything above in place.
		hub.setReady(readyRecord);
		await listenOnSocket(hub, listenPath);
		for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => shutdown(0));
		log(`listening on ${listenPath}`);
	} else {
		const lines = new LineBuffer();
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			for (const line of lines.push(chunk)) stdio?.receive(line);
		});
		process.stdin.on("end", () => shutdown(0));
		hub.setReady(readyRecord);
	}
}

main().catch((e) => {
	log("fatal:", e?.stack ?? e);
	send({ type: "fatal", message: String(e?.message ?? e) });
	process.exit(1);
});
