/**
 * Integration: the Family-C escalation riding the runner (`silo <script>`). Once cooldown has flagged a
 * dependency change, the runner carries the project capability-drift check BEFORE executing — so
 * `silo <script>` is the one command a dev needs. It BLOCKS on un-approved expansion (fail closed, script
 * never runs), CLEARS the marker + runs on a clean surface, and is ignored under CI (where the gate is the
 * drift check). Offline: builtin-only fixtures, so the audit uses builtinCaps and skips the node_modules pass.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { ROOT } from "./_helpers.mjs";

const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const CLI = path.join(ROOT, "cli.ts");

/** Run `silo <args>` in a fixture cwd, with CI/GITHUB_ACTIONS blanked so a test controls them explicitly. */
function silo(cwd, args, env = {}) {
	const r = spawnSync(TSX, [CLI, ...args], { "cwd": cwd, "encoding": "utf8", "env": { ...process.env, "NODE_OPTIONS": "", "CI": "", "GITHUB_ACTIONS": "", ...env } });

	return { "status": r.status ?? 1, "stdout": r.stdout ?? "", "stderr": r.stderr ?? "" };
}

/** Fixture: the capability surface lives in surface.ts; run.ts is the trivial script the runner executes. */
function project(surface) {
	const dir = mkdtempSync(path.join(tmpdir(), "silo-run-"));

	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ "name": "fixture", "private": true, "type": "module" }));
	writeFileSync(path.join(dir, "surface.ts"), surface);
	writeFileSync(path.join(dir, "run.ts"), `console.log("RAN-SCRIPT");\n`);

	return dir;
}

const FS_READ = `import { readFileSync } from "node:fs";\nreadFileSync("x");\n`;
const FS_READ_PLUS_EXEC = `import { readFileSync } from "node:fs";\nimport { execSync } from "node:child_process";\nreadFileSync("x"); execSync("ls");\n`;
const MARKER = (dir) => path.join(dir, ".silo", "pending-review.json");
const dropMarker = (dir) => writeFileSync(MARKER(dir), JSON.stringify({ "at": "2026-07-17T00:00:00.000Z", "reason": "cooldown install", "cooldownDays": 7, "lockBefore": "aaaaaaaaaaaa", "lockAfter": "bbbbbbbbbbbb" }));
const hasMarker = (dir) => existsSync(MARKER(dir));

/** Commit the fixture so the trust ratchet (which is git-diff-scoped) has a base to diff a later edit against. */
function gitCommit(dir) {
	spawnSync("git", ["init", "-q"], { "cwd": dir });
	spawnSync("git", ["add", "-A"], { "cwd": dir });
	spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { "cwd": dir });
}

it("runner escalation: un-approved expansion after a dep change BLOCKS the run", () => {
	const dir = project(FS_READ);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);         // baseline: fs:read only
		writeFileSync(path.join(dir, "surface.ts"), FS_READ_PLUS_EXEC);   // widen the surface: + exec
		dropMarker(dir);
		const r = silo(dir, ["run.ts"]);

		assert.equal(r.status, 1, r.stdout);
		assert.match(r.stderr, /blocked: \d+ un-approved capability change/);
		assert.doesNotMatch(r.stdout, /RAN-SCRIPT/, "the script must NOT execute when the surface widened");
		assert.ok(hasMarker(dir), "a block keeps the marker — it keeps escalating until reviewed");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("runner escalation: an unchanged surface clears the marker and runs the script", () => {
	const dir = project(FS_READ);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);   // baseline
		dropMarker(dir);                                     // deps 'moved' but the surface is unchanged
		const r = silo(dir, ["run.ts"]);

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /RAN-SCRIPT/, "the script runs once the surface checks out");
		assert.equal(hasMarker(dir), false, "a clean review clears the marker");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("runner escalation: the trust ratchet is a NON-BLOCKING nudge (touched, unreviewed, capability-bearing)", () => {
	const dir = project(`import { execSync } from "node:child_process";\nexecSync("ls");\n`);   // surface.ts reaches exec

	gitCommit(dir);
	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);   // baseline captures exec (so touching it later is NOT drift)
		writeFileSync(path.join(dir, "surface.ts"), `import { execSync } from "node:child_process";\nexecSync("pwd");\n`);   // touch it, same capability
		dropMarker(dir);
		const r = silo(dir, ["run.ts"]);

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /trust: \d+ capability-bearing unit\(s\) you've touched are unreviewed/, "the ratchet nudge must appear");
		assert.match(r.stdout, /RAN-SCRIPT/, "the ratchet must NOT block the run — it only nudges");
		assert.equal(hasMarker(dir), false, "no capability drift → marker cleared");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("runner escalation: first-run onboarding — no baseline + marker establishes one, then runs", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	mkdirSync(path.join(dir, ".silo"));   // .silo exists (so a marker can live) but no baseline yet
	dropMarker(dir);
	try {
		assert.equal(existsSync(path.join(dir, ".silo", "baseline.json")), false, "precondition: no baseline");
		const r = silo(dir, ["run.ts"]);

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /establishing your first/i);
		assert.equal(existsSync(path.join(dir, ".silo", "baseline.json")), true, "onboarding writes the first baseline");
		assert.match(r.stdout, /RAN-SCRIPT/, "then runs the script — a self-contained on-ramp");
		assert.equal(hasMarker(dir), false, "marker cleared once onboarded");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("runner escalation: ignored under CI — script runs, marker untouched", () => {
	const dir = project(FS_READ);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);
		writeFileSync(path.join(dir, "surface.ts"), FS_READ_PLUS_EXEC);   // even with a widened surface…
		dropMarker(dir);
		const r = silo(dir, ["run.ts"], { "CI": "true" });   // …CI does not escalate in the runner

		assert.match(r.stdout, /RAN-SCRIPT/, "under CI the runner does not escalate");
		assert.ok(hasMarker(dir), "CI leaves the marker untouched (the gate is `CI=true silo audit`)");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});
