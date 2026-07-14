/**
 * Unit tests for the shared decision core (enforcement/decide.mjs): the redline matrix + JUDICIAL modes.
 * Pure + fast — no subprocess except the BERNARD-env case (REDLINE is built once at import) and the
 * JUDICIAL command mode (which spawns a judge).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { judicial, redline } from "../../enforcement/decide.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECIDE = path.join(HERE, "../../enforcement/decide.mjs");
const JUDGE = path.join(HERE, "fixtures/judge.mjs");

it("redline: catastrophic scopes are flagged", () => {
	for (const s of [
		"fs:write:/Users/x/.ssh/id_rsa",            // credentials
		"fs:write:/home/x/.aws/credentials",
		"fs:write:/Users/x/.npmrc",
		"fs:write:/Users/x/project/.git/config",    // git internals
		"fs:write:/etc/passwd",                      // system dirs
		"fs:write:/usr/bin/x",
		"fs:write:/System/x",
		"exec:rm",
		"exec:/bin/rm",
		"exec:curl",
		"exec:wget",
		"exec:bash",
		"exec:dd",
		"exec:mkfs",
		"exec:nc",
		"net:*",                                     // indeterminate host
		"eval:1+1"                                  // dynamic code
	]) { assert.equal(redline(s), true, `expected redline: ${s}`); }
});

it("redline: benign scopes pass", () => {
	for (const s of [
		"fs:read:/Users/x/.ssh/id_rsa",             // only WRITE to creds is redline
		"fs:write:/tmp/x",
		"fs:write:/Users/x/project/src/a.ts",
		"exec:node",
		"exec:tsc",
		"exec:/usr/local/bin/git",
		"net:localhost",
		"net:example.com:443"
	]) { assert.equal(redline(s), false, `expected benign: ${s}`); }
});

it("judicial: blanket env modes", () => {
	const save = process.env.JUDICIAL;

	try {
		delete process.env.JUDICIAL; assert.equal(judicial({}), null, "unset → null (caller falls back)");
		process.env.JUDICIAL = "ask"; assert.equal(judicial({}), null, "ask → null");
		process.env.JUDICIAL = "allow"; assert.deepEqual(judicial({}), { "behavior": "allow" });
		process.env.JUDICIAL = "deny"; assert.equal(judicial({}).behavior, "deny");
	} finally { if (save === undefined) { delete process.env.JUDICIAL; } else { process.env.JUDICIAL = save; } }
});

it("judicial: command mode spawns a judge and parses its verdict", () => {
	const save = process.env.JUDICIAL;

	process.env.JUDICIAL = `node ${JUDGE}`;
	try {
		assert.equal(judicial({ "scope": "fs:read:/x" }).behavior, "allow");
		assert.equal(judicial({ "scope": "net:localhost:3000" }).behavior, "allow");
		assert.equal(judicial({ "scope": "exec:rm" }).behavior, "deny");
	} finally { if (save === undefined) { delete process.env.JUDICIAL; } else { process.env.JUDICIAL = save; } }
});

it("judicial: bad judge output fails CLOSED (deny)", () => {
	const save = process.env.JUDICIAL;

	process.env.JUDICIAL = `node -e "process.stdout.write('not json')"`;
	try { assert.equal(judicial({ "scope": "fs:read:/x" }).behavior, "deny"); } finally { if (save === undefined) { delete process.env.JUDICIAL; } else { process.env.JUDICIAL = save; } }
});

it("redline: BERNARD env adds extra regexes (read at import)", () => {
	const r = spawnSync(process.execPath, ["--input-type=module",
"-e",`import { redline } from ${JSON.stringify(DECIDE)};`
+ `process.stdout.write(JSON.stringify([redline("fs:write:/tmp/secret-vault/x"), redline("fs:write:/tmp/ok")]));`], { "encoding": "utf8", "env": { ...process.env, "BERNARD": "secret-vault" } });

	assert.deepEqual(JSON.parse(r.stdout), [true, false]);
});
