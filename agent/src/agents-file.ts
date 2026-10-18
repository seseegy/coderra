/**
 * The notes pi reads at the start of every session (<agentDir>/AGENTS.md): what this machine is and how its tools
 * behave. They differ a lot between the phone (an Android shell, no sudo, a proot container) and a server (a real
 * Linux box, bash, a rootless container), and telling the model the wrong one makes it avoid things that work or try
 * things that cannot.
 */

export const AGENTS_MARKER = "<!-- andropi:managed (delete this line to keep your own edits) -->";

/** Starts of the file as older versions wrote it, before the marker existed. Such a file is ours to replace. */
export const LEGACY_STARTS = ["# Environment\n\nYou are running inside AndroPI", "# Environment\n\nYou are running inside CoderRa"];

export interface AgentsFileOptions {
	/** "vps" for the server daemon, anything else for the phone. */
	mode: string;
	workspace: string;
	/** On a server: bash runs inside the rootless container (`box`) rather than directly on the machine. */
	box?: boolean;
}

export function agentsFileText({ mode, workspace, box = false }: AgentsFileOptions): string {
	return mode === "vps" ? serverText(workspace, box) : phoneText(workspace);
}

function phoneText(workspace: string): string {
	return `${AGENTS_MARKER}
# Environment

You are running inside CoderRa, an Android app, on the user's phone.

- The shell is Android's /system/bin/sh (mksh) with toybox utilities, not bash.
  Prefer POSIX sh syntax. There is no sudo, apt or pkg.
- Every bash call starts in the workspace directory; \`cd\` does not persist
  between calls. A grep exit code of 1 means "no matches", not an error.
- On PATH: \`node\`, \`git\`, \`ssh\`, \`ssh-keygen\`, \`scp\`, \`rsync\`, \`curl\`, \`rg\`, \`fd\`.
  With scp, pass \`-S ssh\`.
- The workspace directory is ${workspace}. Projects live in subfolders of it.
  Keep files inside it unless asked otherwise.
- When the user has connected accounts in the app:
  - GitHub: \`$GITHUB_TOKEN\` is set and git is already authenticated for
    https://github.com (clone, pull, push work directly). Use the REST API
    with curl for everything else (issues, PRs, repos).
  - Vercel: \`$VERCEL_TOKEN\` is set for the Vercel REST API.
  - SSH: saved servers are aliases in ~/.ssh/config, so \`ssh <name>\` works.
    The device key is ~/.ssh/id_ed25519.
- Linux container: when the user has installed one (Debian or Alpine, via
  proot), \`box -c '<command>'\` runs a command inside it, and \`box\` alone opens
  a shell. When it is enabled as your shell, every command already runs inside:
  use \`apt-get install -y\` (Debian) or \`apk add\` (Alpine) to get Python,
  Node.js, compilers and anything else. The home folder and workspace are the
  same paths inside and out.
- You have \`web_search\`, \`web_fetch\` and \`web_screenshot\` tools. Use them before guessing how
  to install or use something, and to look up unfamiliar errors.
- Dev servers: run them in the background (\`nohup npm run dev > dev.log 2>&1 &\`)
  and print the URL (e.g. http://localhost:5173); the app offers a live
  preview and a public link for any localhost port it sees.
- Some actions need the user's approval in the app; if one is declined, ask
  what they want instead rather than retrying.
- There is no display server; do not try to open GUIs or browsers. The app can
  preview HTML files you write.
`;
}

function serverText(workspace: string, box: boolean): string {
	const shell = box
		? `- Shell: bash runs inside an Ubuntu container as root, started for you by \`box\`. The workspace is at the same
  path inside and outside, so files are shared. Your home folder has the same path but its own contents (the git and
  ssh settings are copied in). Use \`apt-get install -y\` for anything you need (compilers, Python, databases...).
  Installed packages stay between runs. The container is separate from the server itself, so a mistake in it
  cannot damage the server.`
		: `- Shell: bash runs directly on the server as an unprivileged user. There is no sudo, so \`apt\` is not
  available. Install tools in your home folder instead (nvm, uv, pip --user, cargo, ...).`;
	return `${AGENTS_MARKER}
# Environment

You are running inside CoderRa on a Linux server. The user talks to you from the CoderRa app on their phone and
may disconnect at any time; you keep running while they are away, and they see everything when they return.

- Your file tools (read, write, edit, grep, find, ls) work directly on the server's disk.
- The workspace directory is ${workspace}. Projects live in subfolders of it. Keep files inside it unless asked
  otherwise.
${shell}
- Every bash call starts in the project folder; \`cd\` does not persist between calls. A grep exit code of 1 means
  "no matches", not an error.
- The usual tools (git, curl, rsync, ssh, rg) are installed. Check with \`command -v\` before relying on others.
- When the user has connected accounts in the app:
  - GitHub: \`$GITHUB_TOKEN\` is set and git is already authenticated for https://github.com (clone, pull, push
    work directly). Use the REST API with curl for everything else (issues, PRs, repos).
  - Vercel: \`$VERCEL_TOKEN\` is set for the Vercel REST API.
  - SSH: saved servers are aliases in ~/.ssh/config, so \`ssh <name>\` works.
- You have \`web_search\`, \`web_fetch\` and \`web_screenshot\` tools. Use them before guessing how to install or use
  something, and to look up unfamiliar errors.
- Dev servers: run them in the background (\`nohup npm run dev > dev.log 2>&1 &\`) and print the URL (for example
  http://localhost:5173). The app can open any localhost port you print on the phone through a tunnel.
- Some actions need the user's approval in the app. If one is declined, ask what they want instead of retrying.
  In an unattended run (a scheduled or queued task) nobody can approve: dangerous commands are refused outright.
  Do not look for a way around that; finish what you safely can and say what is left.
- There is no display server; do not try to open GUIs or browsers. The app can preview HTML files you write.
`;
}
