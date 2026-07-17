/**
 * The AI-provenance heuristic (provenance.ts). Structural signal = doc-comment COVERAGE: the
 * fraction of a file's functions carrying a non-JSDoc doc comment (AI documents nearly all; humans
 * selectively). Plus explicit attribution markers. Run via the CLI's --json mode on throwaway fixtures.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { ROOT } from "./_helpers.mjs";

const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const ENGINE = path.join(ROOT, "shared/provenance.ts");

/** Write `src` to a temp file and return its provenance verdict (CLI --json, single-file target). */
function provenance(src, name = "f.ts") {
	const dir = mkdtempSync(path.join(tmpdir(), "silo-prov-"));
	const file = path.join(dir, name);

	writeFileSync(file, src);
	try {
		const r = spawnSync(TSX, [ENGINE, file, "--json"], { "encoding": "utf8", "env": { ...process.env, "NODE_OPTIONS": "" } });

		assert.equal(r.status, 0, r.stderr);

		return JSON.parse(r.stdout)[0];
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
}

it("most functions carry a (terse) non-JSDoc doc comment → likely", () => {
	const r = provenance([
		"// get the token",
		"export function getToken(req) { return req.headers.authorization; }",
		"// validate it",
		"function validate(t) { return store.get(t); }",
		"// look up the user",
		"function user(id) { return db.get(id); }"
	].join("\n"));

	assert.equal(r.verdict, "likely");
	assert.equal(r.documented, 3);
	assert.equal(r.functions, 3);
	assert.ok(r.signals.some((s) => s.name === "doc-coverage"));
});

it("tagged JSDoc does not count → clean", () => {
	const r = provenance([
		"/** @param req @returns token */",
		"export function getToken(req) { return req.headers.authorization; }",
		"/** @param t */",
		"function validate(t) { return store.get(t); }",
		"/** @param id */",
		"function user(id) { return db.get(id); }"
	].join("\n"));

	assert.equal(r.verdict, "clean");
	assert.equal(r.documented, 0);
});

it("selective documentation (below threshold) → clean", () => {
	// Only 1 of 3 functions documented — the human pattern.
	const r = provenance([
		"// the important one",
		"export function getToken(req) { return req.headers.authorization; }",
		"function validate(t) { return store.get(t); }",
		"function user(id) { return db.get(id); }"
	].join("\n"));

	assert.equal(r.verdict, "clean");
	assert.equal(r.documented, 1);
});

it("comment-looking strings are not counted (oxc extraction)", () => {
	const r = provenance([
		`const a = "// get the token";`,
		"export function getToken(req) { return req; }",
		`const b = "// validate";`,
		"function validate(t) { return t; }",
		`const c = "// user";`,
		"function user(id) { return id; }"
	].join("\n"));

	assert.equal(r.verdict, "clean");
	assert.equal(r.documented, 0);
});

it("a comment mentioning a scoped package is NOT mistaken for JSDoc", () => {
	// Regression: `@brianjenkins94`/`@typescript` mid-sentence must not match the JSDoc-tag test (which
	// keys on `@tag` at line-start). Otherwise the comment is wrongly exempted and the fn reads undocumented.
	const r = provenance([
		"// resolve via @brianjenkins94/util, falling back to @typescript/native-preview on PATH",
		"export function resolve(x) { return x; }",
		"// look up the user record",
		"function user(id) { return id; }",
		"// validate the token first",
		"function validate(t) { return t; }"
	].join("\n"));

	assert.equal(r.documented, 3, "scoped-package mentions must still count as doc comments");
	assert.equal(r.verdict, "likely");
});

it("a single documented function is enough → likely (no function-count floor)", () => {
	const r = provenance(`// resolve the thing\nexport function resolve(x) { return x; }\n`);

	assert.equal(r.verdict, "likely");
	assert.equal(r.documented, 1);
	assert.equal(r.functions, 1);
});

it("a single UN-documented function → clean", () => {
	const r = provenance(`export function resolve(x) { return x; }\n`);

	assert.equal(r.verdict, "clean");
	assert.equal(r.documented, 0);
});

it("explicit attribution marker → likely", () => {
	const r = provenance(`export const x = 1;\n// Co-authored-by: Claude\n`);

	assert.equal(r.verdict, "likely");
	assert.equal(r.score, 1);
	assert.ok(r.signals.some((s) => s.name === "marker"));
});
