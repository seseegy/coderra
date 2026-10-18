import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanArguments } from "../src/lenient.js";

const schema = {
	properties: {
		path: { type: "string" },
		offset: { type: "number" },
		limit: { type: "integer" },
		recursive: { type: "boolean" },
		note: { type: "string" },
		maybe: { anyOf: [{ type: "null" }, { type: "integer" }] },
		nested: { type: "object", properties: { n: { type: "number" } } },
	},
	required: ["path"],
};

test("drops placeholder strings for optional non-string parameters", () => {
	for (const placeholder of ["None", "null", "undefined", "nil", "NaN", ""]) {
		const out = cleanArguments({ path: "a", offset: placeholder }, schema) as Record<string, unknown>;
		assert.equal("offset" in out, false, `"${placeholder}" should be dropped`);
	}
});

test("keeps placeholder strings on required parameters", () => {
	const out = cleanArguments({ path: "None" }, schema) as Record<string, unknown>;
	assert.equal(out.path, "None");
});

test("drops None/null/undefined strings for optional string parameters, but keeps an empty string", () => {
	assert.equal("note" in (cleanArguments({ path: "a", note: "None" }, schema) as object), false);
	assert.equal("note" in (cleanArguments({ path: "a", note: "undefined" }, schema) as object), false);
	assert.equal((cleanArguments({ path: "a", note: "" }, schema) as any).note, "");
	assert.equal((cleanArguments({ path: "a", note: "none of the above" }, schema) as any).note, "none of the above");
});

test("converts numbers and booleans sent as strings", () => {
	const out = cleanArguments({ path: "a", offset: "5", limit: " 12 ", recursive: "TRUE" }, schema) as any;
	assert.equal(out.offset, 5);
	assert.equal(out.limit, 12);
	assert.equal(out.recursive, true);
	assert.equal((cleanArguments({ path: "a", recursive: "false" }, schema) as any).recursive, false);
});

test("leaves non-numeric strings for number parameters alone", () => {
	assert.equal((cleanArguments({ path: "a", offset: "five" }, schema) as any).offset, "five");
});

test("reads the type from anyOf, ignoring null", () => {
	assert.equal((cleanArguments({ path: "a", maybe: "7" }, schema) as any).maybe, 7);
});

test("cleans nested objects", () => {
	const out = cleanArguments({ path: "a", nested: { n: "3" } }, schema) as any;
	assert.deepEqual(out.nested, { n: 3 });
});

test("does not mutate its input and passes non-objects through", () => {
	const input = { path: "a", offset: "None" };
	cleanArguments(input, schema);
	assert.deepEqual(input, { path: "a", offset: "None" });
	assert.equal(cleanArguments("x", schema), "x");
	assert.deepEqual(cleanArguments([1, 2], schema), [1, 2]);
	assert.equal(cleanArguments(null, schema), null);
	assert.deepEqual(cleanArguments({ a: "None" }, undefined), { a: "None" });
});
