/**
 * The release-age cooldown engine (install/cooldown.mjs) — runs as the `preinstall` hook and behind
 * `silo install`. No network: fake `pnpm` + `npm` on PATH record their argv. cooldown tries pnpm's native
 * `minimumReleaseAge` first, falling back to npm's `--before`; the fake pnpm fails by default so most
 * cases assert the npm fallback, and one case ({pnpmOk}) asserts the pnpm-first path. We check the
 * computed --before date, --cooldown / SILO_COOLDOWN_DAYS handling, passthrough args, guard, and failure —
 * plus the Family-C breadcrumb: a lock-changing install drops `.silo/pending-review.json` (only inside an
 * existing `.silo/`, only when the lockfile actually moved).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { ROOT } from "./_helpers.mjs";

const COOLDOWN = path.join(ROOT, "install/cooldown.mjs");
const dateBefore = (days) => new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

/** Run cooldown.mjs in a throwaway cwd with fake `pnpm` + `npm` first on PATH, each dumping its argv.
 *  pnpm exits non-zero by default so the npm `--before` fallback runs (what most cases assert); pass
 *  {pnpmOk:true} to make pnpm succeed and exercise the pnpm-first path. `argv` = npm's, `pnpmArgv` = pnpm's
 *  (null when that tool was never invoked). Family-C marker options: {silo} pre-creates `.silo/`, {preLock}
 *  seeds package-lock.json before the run, {shimLock} makes the winning tool rewrite it (mimics a moved
 *  resolution). `pending` = the parsed `.silo/pending-review.json`, `siloCreated` = did `.silo/` exist after. */
function cooldown(args, env = {}, { fail = false, pnpmOk = false, silo = false, preLock = null, shimLock = null } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "silo-cooldown-"));
	const npmArgv = path.join(dir, "npm-argv");
	const pnpmArgv = path.join(dir, "pnpm-argv");

	if (silo) { mkdirSync(path.join(dir, ".silo")); }
	if (preLock !== null) { writeFileSync(path.join(dir, "package-lock.json"), preLock); }
	// When shimLock is set the winning tool rewrites the lockfile, so cooldown observes a changed resolution.
	const writeLock = shimLock === null ? "" : `printf '%s' ${JSON.stringify(shimLock)} > package-lock.json\n`;

	writeFileSync(path.join(dir, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(pnpmArgv)}\n${pnpmOk ? writeLock : ""}exit ${pnpmOk ? 0 : 1}\n`);
	writeFileSync(path.join(dir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(npmArgv)}\n${fail ? "echo 'npm error code ENOVERSIONS' >&2\nexit 1\n" : writeLock}`);
	chmodSync(path.join(dir, "pnpm"), 0o755);
	chmodSync(path.join(dir, "npm"), 0o755);
	const r = spawnSync(process.execPath, [COOLDOWN, ...args], {
		"cwd": dir,
		"encoding": "utf8",
		"env": { ...process.env, "NODE_OPTIONS": "", "PATH": `${dir}:${process.env.PATH}`, ...env }
	});
	const read = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return null; } };
	let pending = null;

	try { pending = JSON.parse(readFileSync(path.join(dir, ".silo", "pending-review.json"), "utf8")); } catch { /* no marker written */ }
	const out = { "status": r.status ?? 1, "stdout": r.stdout ?? "", "stderr": r.stderr ?? "", "argv": read(npmArgv), "pnpmArgv": read(pnpmArgv), "pending": pending, "siloCreated": existsSync(path.join(dir, ".silo")) };

	rmSync(dir, { "recursive": true, "force": true });

	return out;
}

it("default 7-day cooldown: falls back to npm install --before=now-7d", () => {
	const r = cooldown([]);

	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.argv, ["install", `--before=${dateBefore(7)}`]);
});

it("pnpm present: uses native minimumReleaseAge and does NOT fall back to npm", () => {
	const r = cooldown([], {}, { "pnpmOk": true });

	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.pnpmArgv, ["install", `--config.minimumReleaseAge=${7 * 24 * 60}`]);
	assert.equal(r.argv, null, "npm must NOT run when pnpm succeeds");
});

it("--cooldown <n> and --cooldown=<n> both override the window", () => {
	assert.ok(cooldown(["--cooldown", "30"]).argv.includes(`--before=${dateBefore(30)}`));
	assert.ok(cooldown(["--cooldown=14"]).argv.includes(`--before=${dateBefore(14)}`));
});

it("sILO_COOLDOWN_DAYS env sets the window", () => {
	assert.ok(cooldown([], { "SILO_COOLDOWN_DAYS": "21" }).argv.includes(`--before=${dateBefore(21)}`));
});

it("extra args pass through to npm; --cooldown is stripped", () => {
	const r = cooldown(["--cooldown", "10", "left-pad", "--save-dev"]);

	assert.deepEqual(r.argv, ["install", `--before=${dateBefore(10)}`, "left-pad", "--save-dev"]);
});

it("recursion guard: SILO_COOLDOWN_GUARD short-circuits (npm not re-invoked)", () => {
	const r = cooldown([], { "SILO_COOLDOWN_GUARD": "1" });

	assert.equal(r.status, 0);
	assert.equal(r.argv, null, "guarded run must NOT spawn npm again");
});

it("npm failure (too-fresh dep) propagates with a cooldown hint", () => {
	const r = cooldown([], {}, { "fail": true });

	assert.equal(r.status, 1);
	assert.match(r.stderr, /too fresh|cooldown/);
});

it("marker: a lock-changing install in a .silo project writes pending-review.json", () => {
	const r = cooldown([], {}, { "pnpmOk": true, "silo": true, "shimLock": "lock-v2" });

	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.pending, "expected .silo/pending-review.json to be written");
	assert.equal(r.pending.reason, "cooldown install");
	assert.equal(r.pending.cooldownDays, 7);
	assert.ok(r.pending.lockAfter, "records the new lock hash");
	assert.match(r.stderr, /flagged for re-review/);
});

it("marker: unchanged lockfile → no pending-review (nothing new to re-review)", () => {
	const r = cooldown([], {}, { "pnpmOk": true, "silo": true, "preLock": "same", "shimLock": "same" });

	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.pending, null, "an identical lock resolution must not flag a review");
});

it("marker: no .silo/ project → cooldown neither creates one nor writes a marker", () => {
	const r = cooldown([], {}, { "pnpmOk": true, "silo": false, "shimLock": "lock-v2" });

	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.pending, null);
	assert.equal(r.siloCreated, false, "cooldown must not litter .silo/ into a non-silo project");
});

it("marker: also dropped on the npm fallback path", () => {
	const r = cooldown([], {}, { "pnpmOk": false, "silo": true, "shimLock": "lock-v2" });   // pnpm fails → npm writes the lock

	assert.deepEqual(r.argv, ["install", `--before=${dateBefore(7)}`], "took the npm fallback");
	assert.ok(r.pending, "an npm-path install must also flag re-review");
	assert.equal(r.pending.reason, "cooldown install");
});
