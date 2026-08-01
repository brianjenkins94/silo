/**
 * PROTOTYPE — silo's QUALITY/REVIEW axis (sibling to the capability axis; two columns, one engine).
 * A per-UNIT trust vector from cheap static signals — no runtime, no transform yet.
 *
 * A UNIT is a FUNCTION, not a file: `detect/package-capabilities.ts#builtinCaps`. Function-level is
 * what makes the hash anchor useful — editing one function no longer stales your review of everything
 * else in the file. Every byte belongs to exactly one unit: each top-level function / arrow-const /
 * class method, plus a synthetic `#<module>` unit per file holding the leftover top-level glue
 * (imports, constants, side-effect code). Function-level also lines up 1:1 with where the runtime
 * guard sits (enforce/guard) — a guard site IS a unit boundary.
 *
 *   - understood — reviewed at the unit's CURRENT hash? Hash-anchored, so a review goes `stale` the
 *                  instant that unit's source changes. Backward movement is automatic.
 *   - clean      — lint errors/warnings whose line falls inside the unit's span.
 *   - origin     — AI-authorship verdict (reuses provenance.ts). FILE-level, attributed to each
 *                  unit in it (coarse — a per-function refinement is possible, provenance already
 *                  detects doc-blocks per declaration).
 *   - verified   — the guard socket. UNPLUGGED → `—`; phase-1b (the transform) fills it.
 *
 * Store: `.silo/review.json` (committed, like baseline.json — "what I signed off" is real project
 * state). Marking reviewed is the human sign-off = silo's `approve` gesture.
 *
 *   tsx review.ts                       → the review queue (needs-review first)
 *   tsx review.ts <file>#<fn>           → mark ONE unit reviewed at its current hash
 *   tsx review.ts <file>                → mark every unit in <file> reviewed
 */
import { execFileSync, execSync } from "node:child_process";
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
// The PURE review kernel — shared with the browser extension (see commands/review-core.ts). review.ts is
// the NODE orchestration around it: git scoping, fs reads, eslint, provenance, the store on disk.
import { fingerprintsOfSource, type ReviewStore, type Understood, type Unit, understoodOf, unitsOfSource } from "./review-core.js";
import { isGated, reviewRecord, serializeStore } from "./review-store.js";
import { analyzeFile } from "../shared/provenance.js";

export type { Understood, Unit };   // re-export for consumers that imported these from review.js

// ROOT anchors the review store and every git-scoped query. Outside a git repo (a scratch dir, a test
// fixture) there's no history to diff against, so fall back to cwd rather than crashing the whole CLI at
// import: the capability gate still runs; the quality axis is simply empty (nothing tracked to review).
const ROOT = (() => {
	try { return execSync("git rev-parse --show-toplevel", { "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"] }).trim(); } catch { return process.cwd(); }
})();
const STORE = path.join(ROOT, ".silo", "review.json");
const TOP = 20;   // queue rows to show (there are far more units than files)

type Origin = "clean" | "possible" | "likely";

export interface Scored extends Unit {
	"understood": Understood;
	"errors": number;
	"warnings": number;
	"origin": Origin;
	"verified": "—";
	"priority": number;
}

function loadStore(): ReviewStore {
	return fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE)) : {};
}

async function saveStore(store: ReviewStore): Promise<void> {
	await fs.mkdir(path.dirname(STORE), { "recursive": true });
	fs.writeFileSync(STORE, serializeStore(store));
}

function sourceFiles(): string[] {
	// .mjs/.cjs matter most here: silo's enforcement brokers (capability-broker, preload, decide) ARE the
	// security-critical code — excluding them made exactly the code that enforces the boundary unreviewable.
	let tracked: string;

	try { tracked = execSync("git ls-files '*.ts' '*.tsx' '*.mjs' '*.cjs' '*.js'", { "cwd": ROOT, "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"] }); } catch { return []; }   // non-git → nothing tracked to review

	return tracked
		.split("\n")
		.filter(Boolean)
		.filter((f) => !f.startsWith("test/") && !f.includes("node_modules"));
}

/** Every byte of a file lands in exactly one unit: each function span, plus `#<module>` = what's left
 *  over (imports, constants, top-level side effects) once the function spans are cut out. */
function unitsOf(file: string): Unit[] {
	return unitsOfSource(file, fs.readFileSync(path.join(ROOT, file)));
}

/**
 * The base to diff against. `SILO_BASE` wins; else the tracked upstream (a PR's target branch in CI);
 * else HEAD, which locally means "your uncommitted changes".
 */
export function baseRef(): string {
	if (process.env["SILO_BASE"]) { return process.env["SILO_BASE"]; }

	try {
		return execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { "cwd": ROOT, "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "HEAD";
	}
}

/**
 * The units this change TOUCHED — new, or whose source hash moved — versus `base`.
 *
 * This is what the ratchet gates on, and it's why there's no stored counter: an absolute count has to live
 * somewhere, and a committed aggregate merges to a silently-wrong number when two devs each add one. Git
 * already holds the history; ask it. Diff-scoping is also FAIRER (you answer only for what you touched) and
 * immune to a growing repo tripping the gate.
 */
export function touchedUnits(base: string): Set<string> {
	const touched = new Set<string>();
	let files: string[];

	try {
		files = execSync(`git diff --name-only ${base} --`, { "cwd": ROOT, "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"] })
			.split("\n").filter(Boolean).filter((f) => /\.(m|c)?[jt]sx?$/u.test(f) && !f.startsWith("test/"));
	} catch {
		return touched;   // no such base (shallow clone / fresh repo) → nothing to gate on
	}

	for (const file of files) {
		if (!fs.existsSync(path.join(ROOT, file))) { continue; }   // deleted → nothing left to review

		let before = new Map<string, string>();

		try {
			const src = execSync(`git show ${base}:${file}`, { "cwd": ROOT, "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"], "maxBuffer": 32 * 1024 * 1024 });

			before = new Map(unitsOfSource(file, src).map((u) => [u.id, u.hash]));
		} catch { /* new file → every unit is touched */ }

		for (const u of unitsOf(file)) {
			if (before.get(u.id) !== u.hash) { touched.add(u.id); }
		}
	}

	return touched;
}

/** eslint messages per file (line + severity), so we can attribute them to the unit they land in. */
function lintMessages(): Record<string, { "line": number; "severity": number }[]> {
	const out: Record<string, { "line": number; "severity": number }[]> = {};
	const ingest = (json: string) => {
		for (const r of JSON.parse(json)) {
			out[path.relative(ROOT, r.filePath)] = r.messages.map((m: any) => ({ "line": m.line ?? 0, "severity": m.severity }));
		}
	};

	// eslint's OWN cache — it already knows how to skip files whose content+config are unchanged, and it
	// still emits their cached results to the formatter. No point building a second cache on top.
	const cmd = `npx eslint . -f json --cache --cache-location ${JSON.stringify(path.join(ROOT, ".silo", "eslintcache"))}`;

	// Lint data is a nice-to-have (per-unit error/warning counts) — NEVER let it break the review. A giant/
	// truncated eslint report (e.g. it wandered into a build dir) yields unparseable JSON; degrade to no lint
	// data rather than throwing all the way out of `reviewUnits`.
	try {
		ingest(execSync(cmd, { "cwd": ROOT, "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"], "maxBuffer": 128 * 1024 * 1024 }));
	} catch (error) {
		const stdout = (error as { "stdout"?: string }).stdout;   // eslint exits non-zero WITH json on stdout

		try { if (stdout) { ingest(stdout); } } catch { /* unparseable (truncated) report — skip lint data */ }
	}

	return out;
}

/** The scored function-level spectrum. Expensive-ish (one eslint pass + a parse per file) — call once. */
export function reviewUnits(): Scored[] {
	return score(loadStore());
}

/** Worst review state per FILE (unreviewed ≻ stale ≻ reviewed) — what baseline joins onto its dep rows. */
export function fileStates(rows: readonly { "file": string; "understood": Understood }[]): Map<string, Understood> {
	const rank: Record<Understood, number> = { "unreviewed": 3, "stale": 2, "waived": 1, "reviewed": 0 };
	const out = new Map<string, Understood>();

	for (const r of rows) {
		const cur = out.get(r.file);

		if (cur === undefined || rank[r.understood] > rank[cur]) { out.set(r.file, r.understood); }
	}

	return out;
}

/** A unit's review state ONLY (no lint / origin). */
export interface UnitState { "id": string; "file": string; "hash": string; "understood": Understood }

/** Units + understood state, WITHOUT score()'s eslint pass (that pass is only for the lint columns). The
 *  cheap inputs the runner's escalation feeds to gateUnits — reviewUnits() would spawn `npx eslint .`. */
export function reviewStates(): UnitState[] {
	const store = loadStore();
	const out: UnitState[] = [];

	for (const file of sourceFiles()) {
		for (const u of unitsOf(file)) { out.push({ "id": u.id, "file": u.file, "hash": u.hash, "understood": understoodOf(store[u.id], u.hash) }); }
	}

	return out;
}

// THE TRUST RATCHET, diff-scoped: every capability-bearing unit THIS CHANGE TOUCHED must be reviewed (or
// consciously waived). Not "you have debt" (people disable that within a week) — "you made it worse". No
// stored count: an aggregate merges to a silently-wrong number when two devs each add one; git holds the
// history, so ask it. Diff-scoping is fairer too (you answer only for what you touched).
/** Touched, capability-bearing (exposed), and neither reviewed nor waived. Generic so callers keep their row
 *  type — full Scored from the audit flow, light UnitState from the runner. */
export function gateUnits<T extends { "id": string; "file": string; "understood": Understood }>(review: readonly T[], exposed: Set<string>, touched: Set<string>): T[] {
	return review.filter((u) => isGated(exposed.has(u.file), touched.has(u.id), u.understood));
}

/** Record the human sign-off for a unit (`file#fn`) or every unit in a file. Returns what it marked. */
export async function markReviewed(target: string, waived = false): Promise<Unit[]> {
	const store = loadStore();
	const [rawFile, fn] = target.split("#");
	const file = path.relative(ROOT, path.resolve(rawFile));
	const marked = unitsOf(file).filter((u) => fn === undefined || u.id === `${file}#${fn}`);
	const fps = marked.length ? fingerprintsOfSource(file, fs.readFileSync(path.join(ROOT, file))) : {};

	for (const u of marked) { store[u.id] = reviewRecord(u.hash, waived, fps[u.id]); }
	if (marked.length) { await saveStore(store); }

	return marked;
}

/**
 * `silo accept <ref>` — declare the code AS IT WAS at <ref> your human-approved baseline: mark every unit at
 * that revision reviewed, hash-anchored to its shape THEN. On the working tree this makes units unchanged
 * since <ref> read `reviewed`, drifted ones `stale`, and units new since `unreviewed` — so you review FORWARD
 * from a trusted point instead of signing off a whole repo by hand. Merges into the existing store (units not
 * present at <ref> keep whatever verdict they have). Only meaningful because the hash is structural — a
 * reformat between <ref> and now doesn't count as drift (see review-core `canonical`).
 */
export async function acceptRef(ref: string): Promise<{ "units": number; "files": number }> {
	const git = (...args: string[]) => execFileSync("git", args, { "cwd": ROOT, "encoding": "utf8", "maxBuffer": 1 << 28 });

	let commit: string;

	try { commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim(); } catch { throw new Error(`not a commit: ${ref}`); }

	const files = git("ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean).filter((f) => /\.(?:m|c)?[jt]sx?$/u.test(f) && !f.startsWith("test/") && !f.includes("node_modules"));
	const store = loadStore();
	let units = 0;

	for (const f of files) {
		let src: string;

		try { src = git("show", `${commit}:${f}`); } catch { continue; }   // absent/binary at that rev

		try {
			const fps = fingerprintsOfSource(f, src);

			for (const u of unitsOfSource(f, src)) { store[u.id] = reviewRecord(u.hash, false, fps[u.id]); units += 1; }
		} catch { /* unparseable at that rev */ }
	}

	await saveStore(store);

	return { "units": units, "files": files.length };
}

function score(store: ReviewStore): Scored[] {
	const lint = lintMessages();
	const origins = new Map<string, Origin>();
	const rows: Scored[] = [];

	for (const file of sourceFiles()) {
		if (!origins.has(file)) {
			let verdict: Origin = "clean";

			try { verdict = analyzeFile(path.join(ROOT, file)).verdict; } catch { /* unparseable → clean */ }
			origins.set(file, verdict);
		}

		const msgs = lint[file] ?? [];
		const units = unitsOf(file);
		const inSomeFn = (line: number) => units.some((u) => u.endLine > 0 && line >= u.startLine && line <= u.endLine);

		for (const unit of units) {
			const mine = unit.endLine > 0
				? msgs.filter((m) => m.line >= unit.startLine && m.line <= unit.endLine)
				: msgs.filter((m) => !inSomeFn(m.line));   // `#<module>` gets everything outside a function
			const rec = store[unit.id];
			const understood = understoodOf(rec, unit.hash);
			const errors = mine.filter((m) => m.severity === 2).length;
			const warnings = mine.filter((m) => m.severity === 1).length;
			const origin = origins.get(file) ?? "clean";

			// What most needs review: unreviewed dominates, then stale, then AI-likelihood, then errors.
			const priority = (understood === "unreviewed" ? 3 : understood === "stale" ? 2 : 0) * 4
				+ (origin === "likely" ? 2 : origin === "possible" ? 1 : 0)
				+ (errors > 0 ? 2 : warnings > 0 ? 1 : 0);

			rows.push({ ...unit, "understood": understood, "errors": errors, "warnings": warnings, "origin": origin, "verified": "—", "priority": priority });
		}
	}

	return rows.sort((a, b) => b.priority - a.priority || b.errors - a.errors || a.id.localeCompare(b.id));
}

/** The quality-axis section: the queue head + the spectrum summary. Printed by bare `silo`. */
export function printReview(rows: Scored[]): void {
	const dot = { "reviewed": "●", "stale": "◐", "unreviewed": "○" };
	const shown = rows.slice(0, TOP);
	const w = Math.max("unit".length, ...shown.map((r) => r.id.length));   // seed: empty list → no -Infinity

	console.log(`\n  ${"unit".padEnd(w)}  rev  lint    origin    verified`);
	console.log(`  ${"-".repeat(w)}  ---  ------  --------  --------`);

	for (const r of shown) {
		const lint = r.errors ? `${r.errors}e ${r.warnings}w` : r.warnings ? `${r.warnings}w` : "clean";

		console.log(`  ${r.id.padEnd(w)}  ${dot[r.understood]}    ${lint.padEnd(6)}  ${r.origin.padEnd(8)}  ${r.verified}`);
	}

	const rev = rows.filter((r) => r.understood === "reviewed").length;
	const stale = rows.filter((r) => r.understood === "stale").length;

	if (rows.length > TOP) { console.log(`  … ${rows.length - TOP} more`); }
	console.log(`\n  ${rev} reviewed · ${stale} stale · ${rows.length - rev - stale} unreviewed  (of ${rows.length} units, ${new Set(rows.map((r) => r.file)).size} files)`);
	if (rows[0] && rows[0].understood !== "reviewed") { console.log(`  next up: ${rows[0].id}\n`); }
}

// Dev CLI (silo convention — provenance.ts / package-capabilities.ts do the same). The REAL surface is
// bare `silo` (the two-sided baseline), which imports this module; guarded so importing it never runs anything.
if (import.meta.url === `file://${process.argv[1]}`) {
	const target = process.argv[2];

	if (target === undefined) {
		printReview(reviewUnits());
	} else {
		const marked = await markReviewed(target);

		console.log(marked.length
			? `marked reviewed: ${marked.map((u) => `${u.id} @ ${u.hash}`).join("\n                 ")}`
			: `no such unit: ${target}`);
	}
}
