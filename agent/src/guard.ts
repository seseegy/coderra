/**
 * The app's inline pi extension: approvals before risky tool calls, plan
 * mode (read-only until the plan is approved), dev-server detection from
 * command output, and a checkpoint before the agent starts changing files.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * ask_all / ask_risky / auto are the choices the user can make. deny_risky is for unattended runs (scheduled and queued
 * tasks, sub-agents): there is nobody to ask, so what ask_risky would ask about is refused instead.
 */
export type ApprovalMode = "ask_all" | "ask_risky" | "auto" | "deny_risky";

export interface GuardHooks {
	send(record: object): void;
	/** Snapshot the working tree before the agent's first file change in a run. */
	checkpoint(cwd: string, label: string): Promise<void>;
	cwd(): string;
}

/** Tools that change nothing in the project; never need approval, take no checkpoint, and stay on in plan mode.
 * `tasks` only edits the agent's own checklist, which is what a plan turns into. */
const READ_ONLY = new Set(["read", "grep", "find", "ls", "web_search", "web_fetch", "tasks"]);

/** A call that changes nothing: a read-only tool, or a sub-agent that can only read. */
export function isReadOnlyCall(toolName: string, input: Record<string, unknown> = {}): boolean {
	return READ_ONLY.has(toolName) || (toolName === "subagent" && (input.role ?? "explorer") === "explorer");
}

/** Commands worth a second look before they run. */
const RISKY_BASH = [
	/\brm\s+(-[a-z]*r|-[a-z]*f|--recursive|--force)/i,
	/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|rebase)/i,
	/\b(vercel|netlify|wrangler|firebase)\b.*\b(deploy|--prod)\b/i,
	/\bnpm\s+publish\b|\bpip\s+upload\b|\btwine\s+upload\b/i,
	/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
	/\b(dd|mkfs|shred|chmod\s+-R|chown\s+-R)\b/i,
	/\bssh\b|\bscp\b|\brsync\b/i,
	/>\s*\/(etc|usr|bin|system)\b/i,
	/\bkill(all)?\b|\bpkill\b/i,
	/\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\b/i,
];

/** True when `path` (absolute, or relative to `dir`) is `dir` itself or lies inside it. Compares whole path
 * segments, so "/proj-secrets" is not inside "/proj", and ".." segments are resolved before the check. */
export function isInside(path: string, dir: string): boolean {
	const rel = relative(resolve(dir), resolve(dir, path));
	return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Why a call deserves a second look, or null. `mcp` says whether tools from MCP servers count: a person is asked about
 * them, but an unattended run is allowed to use the servers it was set up with. */
function riskOf(toolName: string, input: Record<string, unknown>, cwd: string, mcp = true): string | null {
	if (isReadOnlyCall(toolName, input)) return null;
	if (toolName === "bash") {
		const cmd = String(input.command ?? "");
		const hit = RISKY_BASH.find((re) => re.test(cmd));
		return hit ? "This command can delete data, publish or reach other machines" : null;
	}
	if (toolName === "write" || toolName === "edit") {
		const path = String(input.path ?? "");
		if (path && !isInside(path, cwd)) return "Writes outside the project folder";
		return null;
	}
	// Unknown/custom tools (MCP and friends) are treated as risky.
	return mcp && toolName.startsWith("mcp_") ? "External tool from an MCP server" : null;
}

/** Summary line for the approval card. */
function describe(toolName: string, input: Record<string, unknown>) {
	if (toolName === "bash") return String(input.command ?? "");
	if (typeof input.path === "string") return input.path;
	if (toolName === "subagent") return `${input.role ?? "explorer"}: ${String(input.title ?? input.task ?? "").slice(0, 200)}`;
	return JSON.stringify(input).slice(0, 400);
}

export class Guard {
	mode: ApprovalMode = "ask_risky";
	/** Plan mode: only read-only tools until the user approves the plan. */
	planMode = false;
	/** "Always allow" choices for this app run, keyed by tool + command head. */
	private allowed = new Set<string>();
	private pending = new Map<string, { resolve: (allow: boolean) => void; record: object }>();
	private next = 1;
	private changedThisRun = false;

	constructor(private readonly hooks: GuardHooks) {}

	reply(id: string, allow: boolean, always = false, key?: string) {
		const waiting = this.pending.get(id);
		this.pending.delete(id);
		if (allow && always && key) this.allowed.add(key);
		waiting?.resolve(allow);
	}

	/** Deny everything still waiting (e.g. when the run is aborted). */
	cancelAll() {
		for (const [id, waiting] of this.pending) {
			this.hooks.send({ type: "approval_dismiss", approvalId: id });
			waiting.resolve(false);
		}
		this.pending.clear();
	}

	/** The approval records still waiting for an answer, oldest first, in the shape the app got them. */
	pendingApprovals(): object[] {
		return [...this.pending.values()].map((w) => w.record);
	}

	private ask(toolName: string, input: Record<string, unknown>, reason: string, key: string) {
		const id = `a${this.next++}`;
		const record = { type: "approval", approvalId: id, toolName, summary: describe(toolName, input), reason, key };
		this.hooks.send(record);
		return new Promise<boolean>((resolve) => this.pending.set(id, { resolve, record }));
	}

	/** The pi extension factory. */
	extension = (pi: ExtensionAPI) => {
		pi.on("agent_start", () => {
			this.changedThisRun = false;
		});

		pi.on("tool_call", async (event) => {
			const input = event.input as Record<string, unknown>;
			const cwd = this.hooks.cwd();

			if (this.planMode && !isReadOnlyCall(event.toolName, input)) {
				return {
					block: true,
					reason:
						"Plan mode is on: do not change anything yet. Finish the plan as a numbered list and ask the user to approve it.",
				};
			}

			const risk = this.mode === "ask_all" ? (isReadOnlyCall(event.toolName, input) ? null : "Approval required for every change") : this.mode === "ask_risky" ? riskOf(event.toolName, input, cwd) : this.mode === "deny_risky" ? riskOf(event.toolName, input, cwd, false) : null;
			if (risk && this.mode === "deny_risky") {
				return {
					block: true,
					reason: `Blocked: ${risk.toLowerCase()}. This is an unattended run and nobody can approve it. Do not look for a way around this; finish what you safely can and report what is left.`,
				};
			}
			if (risk) {
				const head = event.toolName === "bash" ? String(input.command ?? "").trim().split(/\s+/).slice(0, 2).join(" ") : event.toolName;
				const key = `${event.toolName}:${head}`;
				if (!this.allowed.has(key)) {
					const ok = await this.ask(event.toolName, input, risk, key);
					if (!ok) return { block: true, reason: "The user declined this action. Ask what they would like instead." };
				}
			}

			// First change in this run: snapshot so the user can undo the whole run.
			if (!isReadOnlyCall(event.toolName, input) && !this.changedThisRun) {
				this.changedThisRun = true;
				await this.hooks.checkpoint(cwd, "Before the agent's changes").catch(() => {});
			}
			return undefined;
		});

		pi.on("tool_result", (event) => {
			if (event.toolName !== "bash") return;
			const text = event.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
			const found = new Set<number>();
			for (const m of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b/g)) {
				const port = Number(m[1]);
				if (port >= 1024 && port <= 65535) found.add(port);
			}
			for (const port of found) this.hooks.send({ type: "dev_server", port, url: `http://localhost:${port}` });
		});
	};
}
