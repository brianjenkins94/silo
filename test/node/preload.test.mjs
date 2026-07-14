/**
 * Integration: the --import PRELOAD (preload.mjs). Same broker, but enforcement is via registerHooks at
 * module-load time on the REAL files — so it also catches what the static bundle can't: dynamic import().
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "vitest";
import { preload } from "./_helpers.mjs";

const TMP = mkdtempSync(path.join(tmpdir(), "silo-pre-"));
const tmp = (n) => path.join(TMP, n);

process.on("exit", () => rmSync(TMP, { "recursive": true, "force": true }));

it("clean script runs", () => {
	const r = preload("clean.mjs", { "JUDICIAL": "deny" });

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /CLEAN 6/);
});

it("fs:write gated — allow vs deny", () => {
	const ok = preload("fsio.mjs", { "JUDICIAL": "allow", "TARGET": tmp("a.txt") });

	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /FS-WROTE silo/);

	const t = tmp("b.txt");
	const no = preload("fsio.mjs", { "JUDICIAL": "deny", "TARGET": t });

	assert.notEqual(no.status, 0);
	assert.match(no.stderr, /DENIED fs:write/);
	assert.equal(existsSync(t), false);
});

it("exec: dangerous bin (rm) redline fail-closed", () => {
	const no = preload("exec.mjs", { "JUDICIAL": "allow", "BIN": "rm", "ARGS": JSON.stringify(["-f", tmp("x")]) });

	assert.notEqual(no.status, 0);
	assert.match(no.stderr, /BERNARD redline|DENIED exec/);
});

it("dynamic import() of node:fs is still intercepted", () => {
	const t = tmp("dyn.txt");
	const no = preload("dynimport.mjs", { "JUDICIAL": "deny", "TARGET": t });

	assert.notEqual(no.status, 0, "dynamic import must not escape the gate");
	assert.match(no.stderr, /DENIED fs:write/);
	assert.equal(existsSync(t), false);
});

it("eval is redline fail-closed", () => {
	const r = preload("codegen.mjs", { "JUDICIAL": "allow", "MODE": "eval" });

	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /BERNARD redline|DENIED eval/);
});
