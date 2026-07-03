/**
 * The release-age cooldown engine (policy/cooldown.mjs) — runs as the `preinstall` hook and behind
 * `silo install`. No network: a fake `npm` on PATH records argv, so we assert the computed --before
 * date, --cooldown / SILO_COOLDOWN_DAYS handling, passthrough args, the recursion guard, and failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ROOT } from "./_helpers.mjs";

const COOLDOWN = path.join(ROOT, "policy/cooldown.mjs");
const dateBefore = (days) => new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

/** Run cooldown.mjs in a throwaway cwd with a fake `npm` first on PATH that dumps its argv. */
function cooldown(args, env = {}, { fail = false } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "silo-cooldown-"));
	const argvFile = path.join(dir, "argv");
	const shim = path.join(dir, "npm");
	writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\n${fail ? "echo 'npm error code ENOVERSIONS' >&2\nexit 1\n" : ""}`);
	chmodSync(shim, 0o755);
	const r = spawnSync(process.execPath, [COOLDOWN, ...args], {
		cwd: dir, encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "", PATH: `${dir}:${process.env.PATH}`, ...env },
	});
	let argv = null;
	try { argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean); } catch { /* npm never called */ }
	rmSync(dir, { recursive: true, force: true });
	return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", argv };
}

test("default 7-day cooldown: runs npm install --before=now-7d", () => {
	const r = cooldown([]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(r.argv, ["install", `--before=${dateBefore(7)}`]);
});

test("--cooldown <n> and --cooldown=<n> both override the window", () => {
	assert.ok(cooldown(["--cooldown", "30"]).argv.includes(`--before=${dateBefore(30)}`));
	assert.ok(cooldown(["--cooldown=14"]).argv.includes(`--before=${dateBefore(14)}`));
});

test("SILO_COOLDOWN_DAYS env sets the window", () => {
	assert.ok(cooldown([], { SILO_COOLDOWN_DAYS: "21" }).argv.includes(`--before=${dateBefore(21)}`));
});

test("extra args pass through to npm; --cooldown is stripped", () => {
	const r = cooldown(["--cooldown", "10", "left-pad", "--save-dev"]);
	assert.deepEqual(r.argv, ["install", `--before=${dateBefore(10)}`, "left-pad", "--save-dev"]);
});

test("recursion guard: SILO_COOLDOWN_GUARD short-circuits (npm not re-invoked)", () => {
	const r = cooldown([], { SILO_COOLDOWN_GUARD: "1" });
	assert.equal(r.status, 0);
	assert.equal(r.argv, null, "guarded run must NOT spawn npm again");
});

test("npm failure (too-fresh dep) propagates with a cooldown hint", () => {
	const r = cooldown([], {}, { fail: true });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /too fresh|cooldown/);
});
