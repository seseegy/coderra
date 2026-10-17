/**
 * web_search, web_fetch and web_screenshot tools, so the agent can look up
 * install steps, docs and error messages instead of guessing.
 *
 * Search works without a key (DuckDuckGo, DuckDuckGo Lite, then Brave, scraped
 * from their HTML pages). A Brave Search or Tavily key, when configured, is used first.
 *
 * Search1API keys (any number, configured in the app) take precedence over
 * everything: search goes through its /search endpoint, fetch through /crawl,
 * and web_screenshot renders through /screenshot. Keys rotate automatically —
 * when one runs out of credits, hits a limit or fails, the next key is tried
 * and the failing one cools down (see s1Call). If every key fails, search and
 * fetch fall back to the keyless chain above.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const UA =
	"Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchKeys {
	brave?: string;
	tavily?: string;
	/** Search1API keys in rotation order; empty/undefined when none are set. */
	search1api?: string[];
}

// ---------------------------------------------------------------------------
// Search1API (https://api.search1api.com) with automatic key rotation

const S1_BASE = process.env.SEARCH1API_BASE_URL ?? "https://api.search1api.com";

/** When a key may be tried again after a failure of the given kind. */
function s1CooldownMs(status: number): number {
	if (status === 401 || status === 403) return 24 * 3600_000; // invalid or forbidden key
	if (status === 402 || status === 429) return 6 * 3600_000; // out of credits / rate limited
	return 5 * 60_000; // 5xx and network errors: brief pause
}

const s1CoolUntil = new Map<string, number>();
/** Index of the key that answered last; rotation resumes from there. */
let s1Cursor = 0;

class S1KeysExhausted extends Error {}

interface S1Ok {
	buf: ArrayBuffer;
	contentType: string;
	/** 0-based index of the key that answered. */
	keyIndex: number;
}

/**
 * POST to Search1API, rotating through `keys` until one answers. A key that
 * fails with an auth, credit, limit or server error is put in cooldown and
 * the next key is tried; a client error (bad request) is thrown at once,
 * because rotating would not fix it. Key material is never put in messages —
 * keys are referred to by position ("key #2") only.
 */
async function s1Call(path: string, body: unknown, keys: string[], signal?: AbortSignal): Promise<S1Ok> {
	const now = Date.now();
	const order: number[] = [];
	for (let i = 0; i < keys.length; i++) order.push((s1Cursor + i) % keys.length);
	const available = order.filter((i) => (s1CoolUntil.get(keys[i]) ?? 0) <= now);
	if (available.length === 0) {
		throw new S1KeysExhausted(
			`Search1API: all ${keys.length} configured key(s) are cooling down after earlier failures`,
		);
	}
	const failures: string[] = [];
	for (const i of available) {
		const key = keys[i];
		let res: Response;
		try {
			res = await fetch(`${S1_BASE}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
				signal,
			});
		} catch (e) {
			if (signal?.aborted) throw e;
			s1CoolUntil.set(key, Date.now() + s1CooldownMs(500));
			failures.push(`key #${i + 1}: ${(e as Error).message}`);
			continue;
		}
		if (res.ok) {
			s1Cursor = i;
			s1CoolUntil.delete(key);
			return { buf: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "", keyIndex: i };
		}
		if (res.status === 400 || res.status === 404 || res.status === 422) {
			const detail = (await res.text().catch(() => "")).slice(0, 300);
			throw new Error(`Search1API ${res.status}${detail ? `: ${detail}` : ""}`);
		}
		s1CoolUntil.set(key, Date.now() + s1CooldownMs(res.status));
		failures.push(`key #${i + 1}: HTTP ${res.status}`);
	}
	throw new S1KeysExhausted(`Search1API: every key failed (${failures.join("; ")})`);
}

function s1Json(ok: S1Ok): any {
	return JSON.parse(new TextDecoder().decode(ok.buf));
}

async function s1Search(q: string, n: number, keys: string[], signal?: AbortSignal): Promise<SearchResult[]> {
	const body = s1Json(await s1Call("/search", { query: q, max_results: n, crawl_results: 0 }, keys, signal));
	const out: SearchResult[] = (body.results ?? [])
		.map((r: any) => ({ title: r.title ?? "", url: r.link ?? r.url ?? "", snippet: r.snippet ?? "" }))
		.filter((r: SearchResult) => r.url);
	if (out.length === 0) throw new Error("Search1API returned no results");
	return out;
}

async function s1Crawl(url: string, keys: string[], signal?: AbortSignal) {
	const body = s1Json(await s1Call("/crawl", { url }, keys, signal));
	const r = body.results ?? {};
	const content = typeof r.content === "string" ? r.content : "";
	if (!content) throw new Error("Search1API crawl returned no content");
	return { url: r.link ?? url, status: 200, contentType: "text/markdown", title: r.title ?? "", text: content };
}

// ---------------------------------------------------------------------------
// Search backends

async function braveSearch(q: string, n: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, {
		headers: { Accept: "application/json", "X-Subscription-Token": key },
		signal,
	});
	if (!res.ok) throw new Error(`Brave ${res.status}`);
	const body = (await res.json()) as any;
	return (body.web?.results ?? []).map((r: any) => ({
		title: r.title,
		url: r.url,
		snippet: stripTags(r.description ?? ""),
	}));
}

async function tavilySearch(q: string, n: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({ query: q, max_results: n }),
		signal,
	});
	if (!res.ok) throw new Error(`Tavily ${res.status}`);
	const body = (await res.json()) as any;
	return (body.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

async function duckSearch(q: string, n: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
		body: `q=${encodeURIComponent(q)}&kl=wt-wt`,
		signal,
	});
	if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
	const html = await res.text();
	const out: SearchResult[] = [];
	const block = /<div class="result results_links[\s\S]*?(?=<div class="result results_links|<\/div>\s*<\/div>\s*<div id="links_wrapper"|$)/g;
	for (const m of html.matchAll(block)) {
		const a = m[0].match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
		if (!a) continue;
		let url = decodeEntities(a[1]);
		const uddg = url.match(/[?&]uddg=([^&]+)/);
		if (uddg) url = decodeURIComponent(uddg[1]);
		if (url.startsWith("//")) url = `https:${url}`;
		if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
		const s = m[0].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
		out.push({ title: stripTags(a[2]), url, snippet: stripTags(s?.[1] ?? "") });
		if (out.length >= n) break;
	}
	if (out.length === 0) throw new Error("DuckDuckGo returned no results");
	return out;
}

const DESKTOP_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

async function duckLiteSearch(q: string, n: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await fetch("https://lite.duckduckgo.com/lite/", {
		method: "POST",
		headers: { "User-Agent": DESKTOP_UA, "Content-Type": "application/x-www-form-urlencoded" },
		body: `q=${encodeURIComponent(q)}`,
		signal,
	});
	if (!res.ok) throw new Error(`DuckDuckGo Lite ${res.status}`);
	const html = await res.text();
	const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
	const out: SearchResult[] = [];
	links.forEach((m, i) => {
		let url = decodeEntities(m[1]);
		const uddg = url.match(/[?&]uddg=([^&]+)/);
		if (uddg) url = decodeURIComponent(uddg[1]);
		if (url.startsWith("//")) url = `https:${url}`;
		if (/duckduckgo\.com\/y\.js/.test(url) || out.length >= n) return;
		out.push({ title: stripTags(m[2]), url, snippet: stripTags(snippets[i]?.[1] ?? "") });
	});
	if (out.length === 0) throw new Error("DuckDuckGo Lite returned no results");
	return out;
}

async function braveHtmlSearch(q: string, n: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`, {
		headers: { "User-Agent": DESKTOP_UA, "Accept-Language": "en-US,en;q=0.8" },
		signal,
	});
	if (!res.ok) throw new Error(`Brave ${res.status}`);
	const html = await res.text();
	const out: SearchResult[] = [];
	for (const block of html.split('data-type="web"').slice(1)) {
		const url = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/)?.[1];
		const title = block.match(/class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
		if (!url || !title) continue;
		const snippet = block.match(/class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
		out.push({ title: stripTags(title), url: decodeEntities(url), snippet: stripTags(snippet).replace(/<!---->/g, "") });
		if (out.length >= n) break;
	}
	if (out.length === 0) throw new Error("Brave returned no results");
	return out;
}

export async function webSearch(q: string, n: number, keys: SearchKeys, signal?: AbortSignal) {
	const attempts: [string, () => Promise<SearchResult[]>][] = [];
	if (keys.search1api?.length) attempts.push(["search1api", () => s1Search(q, n, keys.search1api!, signal)]);
	if (keys.brave) attempts.push(["brave", () => braveSearch(q, n, keys.brave!, signal)]);
	if (keys.tavily) attempts.push(["tavily", () => tavilySearch(q, n, keys.tavily!, signal)]);
	attempts.push(
		["duckduckgo", () => duckSearch(q, n, signal)],
		["duckduckgo-lite", () => duckLiteSearch(q, n, signal)],
		["brave", () => braveHtmlSearch(q, n, signal)],
	);
	const errors: string[] = [];
	for (const [name, attempt] of attempts) {
		try {
			return { engine: name, results: await attempt() };
		} catch (e) {
			if (signal?.aborted) throw e;
			errors.push(`${name}: ${(e as Error).message}`);
		}
	}
	throw new Error(`Search failed (${errors.join("; ")})`);
}

// ---------------------------------------------------------------------------
// Fetch

export async function webFetch(url: string, signal?: AbortSignal) {
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
		redirect: "follow",
		signal,
	});
	const type = res.headers.get("content-type") ?? "";
	const raw = await res.text();
	let text: string;
	let title = "";
	if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
		title = stripTags(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
		text = htmlToText(raw, res.url);
	} else {
		text = raw;
	}
	return { url: res.url, status: res.status, contentType: type, title, text };
}

/** Readable text with light markdown: headings, lists, links and code kept. */
export function htmlToText(html: string, base = ""): string {
	let s = html;
	// Prefer the main content when the page marks it.
	const main = s.match(/<(main|article)\b[\s\S]*?<\/\1>/i);
	if (main && main[0].length > 500) s = main[0];
	s = s.replace(/<(script|style|noscript|svg|head|template|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi, "");
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\n\`\`\`\n${decodeEntities(stripTags(code))}\n\`\`\`\n\n`);
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${decodeEntities(stripTags(code))}\``);
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n\n`);
	s = s.replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
		const label = stripTags(t).trim();
		if (!label) return "";
		let abs = decodeEntities(href);
		try {
			abs = new URL(abs, base).href;
		} catch {}
		return /^https?:/.test(abs) ? `[${label}](${abs})` : label;
	});
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n");
	s = s.replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|dd|dt|h\d)>/gi, "\n\n");
	s = s.replace(/<(td|th)\b[^>]*>/gi, " | ");
	s = decodeEntities(stripTags(s));
	return s
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function stripTags(s: string) {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+\n/g, "\n").trim();
}

function decodeEntities(s: string) {
	return s
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Tool definitions for the pi SDK

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function webTools(keys: () => SearchKeys) {
	return [
		{
			name: "web_search",
			label: "Web search",
			description:
				"Search the web. Use it to find install instructions, documentation, package names, API usage, and fixes for errors instead of guessing. Returns titles, URLs and snippets; follow up with web_fetch to read a page.",
			promptSnippet: "web_search: search the web for docs, install steps, and error fixes",
			promptGuidelines: [
				"When unsure how to install or use something, or an error is unfamiliar, use web_search and then web_fetch the most relevant result before acting.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				count: Type.Optional(Type.Number({ description: "Number of results (default 8, max 20)" })),
			}),
			async execute(_id: string, params: { query: string; count?: number }, signal?: AbortSignal) {
				// Models trained on other search tools often send numResults/limit instead.
				const alt = params as any;
				const requested = Number(params.count ?? alt.numResults ?? alt.num_results ?? alt.limit ?? 8) || 8;
				const n = Math.min(Math.max(requested, 1), 20);
				const { engine, results } = await webSearch(params.query, n, keys(), signal);
				const body = results
					.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
					.join("\n\n");
				return text(`Results for "${params.query}" (${engine}):\n\n${body}`);
			},
		},
		{
			name: "web_fetch",
			label: "Fetch page",
			description:
				"Fetch a web page or raw file by URL and return its readable text (HTML is converted to markdown-like text). Long pages are paged: pass `offset` from the previous result to continue.",
			promptSnippet: "web_fetch: read a web page or raw file as text",
			parameters: Type.Object({
				url: Type.String({ description: "The URL to fetch" }),
				offset: Type.Optional(Type.Number({ description: "Character offset to continue from (default 0)" })),
				maxChars: Type.Optional(Type.Number({ description: "Characters to return (default 20000)" })),
			}),
			async execute(_id: string, params: { url: string; offset?: number; maxChars?: number }, signal?: AbortSignal) {
				const allKeys = keys();
				const target = /^https?:\/\//i.test(params.url) ? params.url : `https://${params.url}`;
				let page: Awaited<ReturnType<typeof webFetch>>;
				if (allKeys.search1api?.length) {
					try {
						page = await s1Crawl(target, allKeys.search1api, signal);
					} catch (e) {
						if (signal?.aborted) throw e;
						page = await webFetch(params.url, signal);
					}
				} else {
					page = await webFetch(params.url, signal);
				}
				const offset = Math.max(params.offset ?? 0, 0);
				const max = Math.min(Math.max(params.maxChars ?? 20000, 1000), 60000);
				const chunk = page.text.slice(offset, offset + max);
				const more = offset + max < page.text.length;
				const head = [
					`URL: ${page.url} (HTTP ${page.status})`,
					page.title ? `Title: ${page.title}` : null,
					`Showing ${offset}-${offset + chunk.length} of ${page.text.length} characters${more ? `; continue with offset ${offset + chunk.length}` : ""}`,
				]
					.filter(Boolean)
					.join("\n");
				return text(`${head}\n\n${chunk}`);
			},
		},
		{
			name: "web_screenshot",
			label: "Screenshot page",
			description:
				"Render a public web page with Search1API and return a screenshot image you can look at. Use it when layout or visual state matters. Requires a Search1API key (the user adds keys in the app under Network settings); keys rotate automatically when one runs out of credits. Costs 2 credits per screenshot.",
			promptSnippet: "web_screenshot: render a web page and see it as an image",
			parameters: Type.Object({
				url: Type.String({ description: "The public URL to render" }),
				fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole page instead of the viewport (default false)" })),
				format: Type.Optional(Type.String({ description: "png (default), jpeg or webp" })),
			}),
			async execute(
				_id: string,
				params: { url: string; fullPage?: boolean; format?: string },
				signal?: AbortSignal,
				_onUpdate?: unknown,
				ctx?: { cwd?: string },
			) {
				const allKeys = keys();
				if (!allKeys.search1api?.length) {
					return text(
						"web_screenshot needs a Search1API key, and none is configured. Ask the user to add one in the app: Network settings → Web search → Search1API.",
					);
				}
				const format = ["png", "jpeg", "webp"].includes(params.format ?? "") ? params.format! : "png";
				const target = /^https?:\/\//i.test(params.url) ? params.url : `https://${params.url}`;
				const ok = await s1Call(
					"/screenshot",
					{ url: target, format, full_page: params.fullPage ?? false },
					allKeys.search1api,
					signal,
				);
				const mimeType = ok.contentType.startsWith("image/")
					? ok.contentType.split(";")[0]
					: `image/${format}`;
				let saved = "";
				if (ctx?.cwd) {
					try {
						const ext = format === "jpeg" ? "jpg" : format;
						const path = join(ctx.cwd, `screenshot-${Date.now()}.${ext}`);
						writeFileSync(path, Buffer.from(ok.buf));
						saved = path;
					} catch {}
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Screenshot of ${target} (Search1API key #${ok.keyIndex + 1})${saved ? `\nSaved to ${saved}` : ""}`,
						},
						{ type: "image" as const, data: Buffer.from(ok.buf).toString("base64"), mimeType },
					],
					details: undefined,
				};
			},
		},
	];
}
