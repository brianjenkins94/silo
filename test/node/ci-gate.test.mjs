/**
 * Integration: the CI capability gate (`CI=true silo audit`) — the engine behind the GitHub Action.
 * Fully offline: a builtin-only fixture project, so consumer analysis uses builtinCaps (no network) and
 * `audit` skips the node_modules pass. Asserts the three gate outcomes: no baseline → fail, no drift →
 * pass, capability expansion → fail (with the GitHub ::error annotation under GITHUB_ACTIONS).
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

/** Run `silo <args>` with cwd = a throwaway project dir. Blanks CI/GITHUB_ACTIONS in the base env so the
 *  gate is armed ONLY by what a test passes (the suite itself runs under CI=true, which would otherwise
 *  turn every baseline-writing call into a gate). */
function silo(cwd, args, env = {}) {
	const r = spawnSync(TSX, [CLI, ...args], { "cwd": cwd, "encoding": "utf8", "env": { ...process.env, "NODE_OPTIONS": "", "CI": "", "GITHUB_ACTIONS": "", ...env } });

	return { "status": r.status ?? 1, "stdout": r.stdout ?? "", "stderr": r.stderr ?? "" };
}

function project(sourceLines) {
	const dir = mkdtempSync(path.join(tmpdir(), "silo-ci-"));

	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ "name": "fixture", "private": true, "type": "module" }));
	writeFileSync(path.join(dir, "app.ts"), sourceLines);

	return dir;
}

/** Drop / detect the Family-C breadcrumb cooldown would leave (`.silo/` must already exist, i.e. after a
 *  first audit wrote the baseline). */
const MARKER = (dir) => path.join(dir, ".silo", "pending-review.json");
function dropMarker(dir) {
	writeFileSync(MARKER(dir), JSON.stringify({ "at": "2026-07-17T00:00:00.000Z", "reason": "cooldown install", "cooldownDays": 7, "lockBefore": "aaaaaaaaaaaa", "lockAfter": "bbbbbbbbbbbb" }));
}
const hasMarker = (dir) => existsSync(MARKER(dir));

it("cI gate: no committed baseline → fail (with GitHub annotation)", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		const r = silo(dir, ["audit", "."], { "CI": "true", "GITHUB_ACTIONS": "true" });

		assert.equal(r.status, 1);
		assert.match(r.stderr, /no committed baseline/);
		assert.match(r.stdout, /::error title=Silo capability gate::/);
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("cI gate: baseline present, no change → pass", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		const gen = silo(dir, ["audit", "."]);                 // first run writes the baseline

		assert.equal(gen.status, 0, gen.stderr);
		const r = silo(dir, ["audit", "."], { "CI": "true" });

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /no capability drift/);
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("cI gate: capability expansion (new exec cap) → fail", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);     // baseline: fs:read only
		writeFileSync(path.join(dir, "app.ts"),                // expand: add child_process (exec)
			`import { readFileSync } from "node:fs";\nimport { execSync } from "node:child_process";\nreadFileSync("x"); execSync("ls");\n`);
		const r = silo(dir, ["audit", "."], { "CI": "true" });

		assert.equal(r.status, 1);
		assert.match(r.stderr, /un-approved capability change/);
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("cI gate: a nested private workspace is ignored (its caps don't count as drift)", () => {
	// Root uses fs:read. A nested `private: true` sub-package uses exec — but a private workspace
	// self-governs, so silo must prune it: the root baseline never sees exec, and audit stays clean.
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);
	const sub = path.join(dir, "playground");

	mkdirSync(sub);
	writeFileSync(path.join(sub, "package.json"), JSON.stringify({ "name": "playground", "private": true, "type": "module" }));
	writeFileSync(path.join(sub, "app.ts"), `import { execSync } from "node:child_process";\nexecSync("ls");\n`);
	try {
		const gen = silo(dir, ["audit", "."]);

		assert.equal(gen.status, 0, gen.stderr);
		assert.doesNotMatch(gen.stdout, /exec/, "private subproject's exec cap must not leak into the root baseline");
		const r = silo(dir, ["audit", "."], { "CI": "true" });

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /no capability drift/);
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("cI gate: a private project audited directly IS governed (target is never pruned)", () => {
	// The pruning only skips NESTED private workspaces — the audit target itself is always analyzed,
	// so `cd <private-pkg> && silo audit` still works (every ci-gate fixture project is private:true).
	const dir = project(`import { execSync } from "node:child_process";\nexecSync("ls");\n`);

	try {
		const r = silo(dir, ["audit", "."]);

		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /exec/, "a private target must still have its own caps analyzed");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("audit annotates a capability introduced by likely-AI-authored code", () => {
	// Baseline on a clean fs:read file, then add a SECOND file (AI register + attribution marker) that
	// brings in exec. The drift line must carry the ⚠ likely-AI marker and the summary must count it.
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);
		writeFileSync(path.join(dir, "cleanup.ts"), `// This function handles cleanup and runs a shell command.\n// Co-authored-by: Claude\nimport { execSync } from "node:child_process";\nexecSync("ls");\n`);
		const r = silo(dir, ["audit", "."]);

		assert.match(r.stdout, /node:child_process.*⚠ likely-AI/);
		assert.match(r.stdout, /introduced by likely-AI-authored code/);
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("audit does NOT flag a capability introduced by terse human-authored code", () => {
	// Same expansion, but the introducing file has only a terse comment — no AI marker should appear.
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);
		writeFileSync(path.join(dir, "cleanup.ts"), `// rm tmp\nimport { execSync } from "node:child_process";\nexecSync("ls");\n`);
		const r = silo(dir, ["audit", "."]);

		assert.match(r.stdout, /node:child_process/);
		assert.doesNotMatch(r.stdout, /likely-AI/);
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("cI gate: the CI gate never rubber-stamps (ignores --approve)", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);
		writeFileSync(path.join(dir, "app.ts"), `import { execSync } from "node:child_process";\nexecSync("ls");\n`);
		const r = silo(dir, ["audit", ".", "--approve"], { "CI": "true" });   // --approve must NOT save under CI

		assert.equal(r.status, 1, "drift must still fail even with --approve passed in CI");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("pending marker: a no-drift review announces the dep change and clears the marker", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);   // baseline
		dropMarker(dir);
		const r = silo(dir, ["audit", "."]);

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /dependencies changed/);
		assert.match(r.stdout, /nothing to re-review/);
		assert.equal(hasMarker(dir), false, "marker must be cleared once the dep change is reviewed");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("pending marker: un-approved drift KEEPS the marker (keeps escalating until approved)", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);
		writeFileSync(path.join(dir, "app.ts"), `import { execSync } from "node:child_process";\nexecSync("ls");\n`);
		dropMarker(dir);
		const r = silo(dir, ["audit", "."]);   // local, non-approve → drift fails

		assert.equal(r.status, 1);
		assert.match(r.stdout, /dependencies changed/);
		assert.ok(hasMarker(dir), "un-approved drift must leave the marker in place");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("pending marker: --approve accepts the new surface and clears the marker", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);
		writeFileSync(path.join(dir, "app.ts"), `import { execSync } from "node:child_process";\nexecSync("ls");\n`);
		dropMarker(dir);
		const r = silo(dir, ["audit", ".", "--approve"]);

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.equal(hasMarker(dir), false, "approve must clear the marker");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});

it("pending marker: CI ignores it — gate result unchanged, marker untouched", () => {
	const dir = project(`import { readFileSync } from "node:fs";\nreadFileSync("x");\n`);

	try {
		assert.equal(silo(dir, ["audit", "."]).status, 0);   // baseline, no drift
		dropMarker(dir);
		const r = silo(dir, ["audit", "."], { "CI": "true" });

		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.match(r.stdout, /no capability drift/);
		assert.doesNotMatch(r.stdout, /dependencies changed/, "no escalation banner under CI");
		assert.ok(hasMarker(dir), "CI must not clear the marker");
	} finally { rmSync(dir, { "recursive": true, "force": true }); }
});
