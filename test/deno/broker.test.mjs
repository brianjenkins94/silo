/**
 * Integration: the Deno PERMISSION BROKER (deno-broker.mjs). Deno enforces; silo decides. Asserts the
 * permission→scope mapping (read/write/net/run), JUDICIAL allow/deny, and BERNARD redline fail-closed.
 * Run with: deno test -A test/deno/
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runUnderBroker, FIXTURE } from "./_helpers.mjs";

const TMP = mkdtempSync(path.join(tmpdir(), "silo-deno-"));
const tmp = (n) => path.join(TMP, n);
globalThis.addEventListener?.("unload", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

Deno.test("fs:read allowed by JUDICIAL=allow", async () => {
	const f = tmp("r.txt"); writeFileSync(f, "hello");
	const r = await runUnderBroker([FIXTURE("io.ts")], { env: { JUDICIAL: "allow", MODE: "read", TARGET: f } });
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /READ 5/);
});

Deno.test("fs:write to /tmp allowed; write to ~/.ssh-like is redline fail-closed", async () => {
	const ok = tmp("w.txt");
	const a = await runUnderBroker([FIXTURE("io.ts")], { env: { JUDICIAL: "allow", MODE: "write", TARGET: ok } });
	assert.equal(a.code, 0, a.stderr);
	assert.match(a.stdout, /WROTE/);

	const ssh = path.join(TMP, ".ssh", "id_rsa");
	const b = await runUnderBroker([FIXTURE("io.ts")], { env: { JUDICIAL: "allow", MODE: "write", TARGET: ssh } });
	assert.notEqual(b.code, 0);
	assert.equal(existsSync(ssh), false, "redline write must not happen");
});

Deno.test("net denied by JUDICIAL=deny", async () => {
	const r = await runUnderBroker([FIXTURE("net.ts")], { env: { JUDICIAL: "deny", URL: "http://example.com/" } });
	assert.notEqual(r.code, 0);
});

// NOTE Deno asymmetry: the `run` permission query carries value:null — Deno does NOT tell the broker
// WHICH binary is being spawned. So `exec` is a coarse all-or-nothing gate here (can't per-bin redline
// `rm` the way the Node broker can via execFileSync's a[0]). We assert the coarse allow/deny instead.
Deno.test("run gated coarsely (Deno withholds the binary): allow vs deny", async () => {
	const ok = await runUnderBroker([FIXTURE("run.ts")], { env: { JUDICIAL: "allow", BIN: "echo", ARGS: JSON.stringify(["hi"]) } });
	assert.equal(ok.code, 0, ok.stderr);
	assert.match(ok.stdout, /RAN/);

	const survivor = tmp("keep.txt"); writeFileSync(survivor, "important");
	const no = await runUnderBroker([FIXTURE("run.ts")], { env: { JUDICIAL: "deny", BIN: "rm", ARGS: JSON.stringify(["-f", survivor]) } });
	assert.notEqual(no.code, 0);
	assert.equal(existsSync(survivor), true, "denied subprocess must not run");
});
