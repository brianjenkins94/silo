/**
 * Integration: the BOX runner (instrument.ts bundles the broker in; node runs the bundle). Covers every
 * gate — fs read/write, exec, net, eval — across allow (allowlist / JUDICIAL) vs deny vs BERNARD redline.
 * No TTY in the test child, so redline scopes fail CLOSED (which is the property we want to assert).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "vitest";
import { box } from "./_helpers.mjs";

const TMP = mkdtempSync(path.join(tmpdir(), "silo-box-"));
const tmp = (n) => path.join(TMP, n);

process.on("exit", () => rmSync(TMP, { "recursive": true, "force": true }));

it("clean script runs under any policy", () => {
	const r = box("clean.mjs", { "JUDICIAL": "deny" });

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /CLEAN 6/);
});

it("fs:write allowed by JUDICIAL=allow, denied by JUDICIAL=deny", () => {
	const target = tmp("w.txt");
	const ok = box("fsio.mjs", { "JUDICIAL": "allow", "TARGET": target });

	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /FS-WROTE silo/);

	const target2 = tmp("w2.txt");
	const no = box("fsio.mjs", { "JUDICIAL": "deny", "TARGET": target2 });

	assert.notEqual(no.status, 0);
	assert.match(no.stderr, /DENIED fs:write/);
	assert.equal(existsSync(target2), false, "denied write must not create the file");
});

it("fs:write allowed via ALLOW_FS allowlist (no JUDICIAL)", () => {
	const target = tmp("allowed.txt");
	const r = box("fsio.mjs", { "ALLOW_FS": TMP, "TARGET": target });

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /FS-WROTE silo/);
});

it("fs:write to credentials is BERNARD redline — fail-closed even with JUDICIAL=allow", () => {
	const guard = tmp("fake.ssh");      // simulate a creds path the redline matches
	const sshLike = path.join(TMP, ".ssh", "id_rsa");
	const r = box("fsio.mjs", { "JUDICIAL": "allow", "TARGET": sshLike });

	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /BERNARD redline|fs:write/);
	assert.equal(existsSync(sshLike), false);
	void guard;
});

it("exec: benign bin allowed, dangerous bin (rm) is redline fail-closed", () => {
	const ok = box("exec.mjs", { "JUDICIAL": "allow", "BIN": process.execPath, "ARGS": JSON.stringify(["-e", "process.stdout.write('child')"]) });

	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /EXEC-RAN child/);

	const survivor = tmp("keep.txt");

	writeFileSync(survivor, "important");
	const no = box("exec.mjs", { "JUDICIAL": "allow", "BIN": "rm", "ARGS": JSON.stringify(["-f", survivor]) });

	assert.notEqual(no.status, 0);
	assert.match(no.stderr, /BERNARD redline|DENIED exec/);
	assert.equal(existsSync(survivor), true, "redline rm must not run");
});

it("net: external host denied by JUDICIAL=deny", () => {
	const r = box("net.mjs", { "JUDICIAL": "deny", "URL": "http://example.com/" });

	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /DENIED net:example\.com/);
});

it("eval / Function / AsyncFunction / Generator are all redline fail-closed", () => {
	for (const MODE of ["eval", "fn", "asyncfn", "gen"]) {
		const r = box("codegen.mjs", { "JUDICIAL": "allow", "MODE": MODE });

		assert.notEqual(r.status, 0, `${MODE} should be denied`);
		assert.match(r.stderr, /BERNARD redline|DENIED eval/, MODE);
		assert.doesNotMatch(r.stdout, /CODEGEN/, `${MODE} body must not run`);
	}
});
