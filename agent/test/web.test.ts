import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearch1apiKeys } from "../src/integrations.js";
import { htmlToText, webSearch } from "../src/web.js";

test("parseSearch1apiKeys splits on lines, commas, semicolons and spaces, then dedupes in order", () => {
	assert.deepEqual(parseSearch1apiKeys("aaaaaaaa\nbbbbbbbb, cccccccc;aaaaaaaa  dddddddd"), [
		"aaaaaaaa",
		"bbbbbbbb",
		"cccccccc",
		"dddddddd",
	]);
});

test("parseSearch1apiKeys drops entries shorter than 8 characters and handles empty input", () => {
	assert.deepEqual(parseSearch1apiKeys("short\nlong-enough-key"), ["long-enough-key"]);
	assert.deepEqual(parseSearch1apiKeys(""), []);
	assert.deepEqual(parseSearch1apiKeys(undefined), []);
});

test("htmlToText keeps headings, links, lists and code, and drops scripts and styles", () => {
	const html =
		'<html><head><title>T</title><style>.a{}</style></head><body><h1>Title</h1>' +
		'<p>Hello <a href="/x">link</a> &amp; <b>bold</b></p><ul><li>one</li><li>two</li></ul>' +
		"<script>alert(1)</script><pre><code>npm install foo</code></pre></body></html>";
	const text = htmlToText(html, "https://example.com/docs/");
	assert.match(text, /# Title/);
	assert.match(text, /\[link\]\(https:\/\/example\.com\/x\) & bold/);
	assert.match(text, /- one/);
	assert.match(text, /- two/);
	assert.match(text, /```\nnpm install foo\n```/);
	assert.doesNotMatch(text, /alert\(1\)/);
	assert.doesNotMatch(text, /\.a\{\}/);
});

test("htmlToText prefers a long <main> over the rest of the page", () => {
	const html = `<div>OUTSIDE</div><main>${"word ".repeat(120)}</main>`;
	const text = htmlToText(html);
	assert.doesNotMatch(text, /OUTSIDE/);
	assert.match(text, /word word/);
});

test("htmlToText keeps a literal < inside a code block", () => {
	const text = htmlToText("<body><pre><code>if (a &lt; b) run()</code></pre></body>");
	assert.match(text, /```\nif \(a < b\) run\(\)\n```/);
});

test("htmlToText keeps escaped angle brackets in inline code, headings and link text", () => {
	const text = htmlToText(
		'<h2>Using &lt;div&gt; tags</h2><p>Use <code>a&lt;b</code> or <a href="https://example.com/">&lt;a&gt; link</a>.</p><p>Done</p>',
	);
	assert.match(text, /## Using <div> tags/);
	assert.match(text, /`a<b`/);
	assert.match(text, /\[<a> link\]\(https:\/\/example\.com\/\)/);
	assert.match(text, /Done/);
});

test("htmlToText keeps a bare < or > that is not a tag", () => {
	const text = htmlToText("<p>1 < 2 and 3 > 2, x<3</p><p>after</p>");
	assert.match(text, /1 < 2 and 3 > 2, x<3/);
	assert.match(text, /after/);
});

// ---------------------------------------------------------------------------
// Search1API key rotation. The cooldown map is module state, so these three tests build on each other and rely on
// node:test running a file's tests in order.

const KEY_1 = "key-one-aaaaaaaa";
const KEY_2 = "key-two-bbbbbbbb";
const S1 = "https://api.search1api.com";
const hit = { results: [{ title: "Result", link: "https://example.test/", snippet: "snippet" }] };

function stubFetch(t: { after: (fn: () => void) => void }, answer: (key: string) => Response) {
	const calls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: any, init?: any) => {
		if (!String(url).startsWith(S1)) throw new Error("offline");
		const key = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
		calls.push(key);
		return answer(key);
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	return calls;
}

test("search rotates to the next key when one is out of credits", async (t) => {
	const calls = stubFetch(t, (key) =>
		key === KEY_1 ? new Response("{}", { status: 402 }) : new Response(JSON.stringify(hit), { status: 200 }),
	);
	const out = await webSearch("anything", 5, { search1api: [KEY_1, KEY_2] });
	assert.equal(out.engine, "search1api");
	assert.equal(out.results[0].url, "https://example.test/");
	assert.deepEqual(calls, [KEY_1, KEY_2]);
});

test("a key that failed is skipped while it cools down, and key material never reaches the error", async (t) => {
	const calls = stubFetch(t, () => new Response("{}", { status: 429 }));
	await assert.rejects(
		() => webSearch("anything", 5, { search1api: [KEY_1, KEY_2] }),
		(e: Error) => {
			assert.match(e.message, /All search providers failed/);
			assert.match(e.message, /key #2: HTTP 429/);
			assert.doesNotMatch(e.message, new RegExp(`${KEY_1}|${KEY_2}`));
			return true;
		},
	);
	assert.deepEqual(calls, [KEY_2], "key #1 is still cooling down from the previous test");
});

test("with every key cooling down it falls through to the keyless engines", async (t) => {
	const calls = stubFetch(t, () => new Response(JSON.stringify(hit), { status: 200 }));
	await assert.rejects(
		() => webSearch("anything", 5, { search1api: [KEY_1, KEY_2] }),
		/all 2 configured key\(s\) are cooling down/,
	);
	assert.deepEqual(calls, []);
});
