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
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
import { parseSync } from "oxc-parser";
import { analyzeFile } from "../shared/provenance.js";

// ROOT anchors the review store and every git-scoped query. Outside a git repo (a scratch dir, a test
// fixture) there's no history to diff against, so fall back to cwd rather than crashing the whole CLI at
// import: the capability gate still runs; the quality axis is simply empty (nothing tracked to review).
const ROOT = (() => {
	try { return execSync("git rev-parse --show-toplevel", { "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"] }).trim(); } catch { return process.cwd(); }
})();
const STORE = path.join(ROOT, ".silo", "review.json");
const TOP = 20;   // queue rows to show (there are far more units than files)

interface ReviewRecord { "hash": string; "note"?: string; "at": string; "waived"?: boolean }
type ReviewStore = Record<string, ReviewRecord>;

/** `waived` = consciously accepted WITHOUT reading it. It satisfies the gate but is NOT trust — the ledger
 *  says so, the queue shows it, and it's hash-anchored like a review, so editing the unit raises it again.
 *  This replaces a global "accepted debt" counter: a per-unit ledger entry can't silently merge wrong. */
export type Understood = "reviewed" | "waived" | "stale" | "unreviewed";
type Origin = "clean" | "possible" | "likely";

export interface Unit {
	"id": string;            // `<file>#<fn>` — `#<module>` = the file's top-level glue
	"file": string;
	"hash": string;
	"startLine": number;
	"endLine": number;
}

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
	fs.writeFileSync(STORE, JSON.stringify(store, undefined, 2) + "\n");
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

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Offsets of each line start, so an offset → 1-based line is a cheap lookup. */
function lineIndex(src: string): number[] {
	const starts = [0];

	for (let i = 0; i < src.length; i += 1) { if (src[i] === "\n") { starts.push(i + 1); } }

	return starts;
}

function lineAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;

	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);

		if (starts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
	}

	return lo + 1;
}

/** Top-level functions / arrow-consts / class methods, with their source spans. Mirrors the declaration
 *  shapes provenance.ts already recognises. */
function spans(file: string, src: string): { "name": string; "start": number; "end": number }[] {
	const { program } = parseSync(file, src) as any;
	const out: { "name": string; "start": number; "end": number }[] = [];

	for (const stmt of (program.body ?? []) as any[]) {
		const decl = stmt.type?.startsWith("Export") ? (stmt.declaration ?? stmt) : stmt;

		if (decl?.type === "FunctionDeclaration" || decl?.type === "TSDeclareFunction") {
			out.push({ "name": decl.id?.name ?? "(anonymous)", "start": stmt.start, "end": stmt.end });
		} else if (decl?.type === "VariableDeclaration") {
			for (const v of decl.declarations ?? []) {
				if (v.init && (v.init.type === "ArrowFunctionExpression" || v.init.type === "FunctionExpression")) {
					out.push({ "name": v.id?.name ?? "(anonymous)", "start": stmt.start, "end": stmt.end });
				}
			}
		} else if (decl?.type === "ClassDeclaration") {
			const cls = decl.id?.name ?? "(class)";

			for (const m of decl.body?.body ?? []) {
				if (m.type === "MethodDefinition") { out.push({ "name": `${cls}.${m.key?.name ?? "?"}`, "start": m.start, "end": m.end }); }
			}
		}
	}

	return out.sort((a, b) => a.start - b.start);
}

/** Every byte of a file lands in exactly one unit: each function span, plus `#<module>` = what's left
 *  over (imports, constants, top-level side effects) once the function spans are cut out. */
function unitsOf(file: string): Unit[] {
	return unitsOfSource(file, fs.readFileSync(path.join(ROOT, file)));
}

/** Split+hash units from SOURCE TEXT, so the same logic works on a git revision (`git show base:file`). */
function unitsOfSource(file: string, src: string): Unit[] {
	const starts = lineIndex(src);
	const fns = spans(file, src);

	const units: Unit[] = fns.map((f) => ({
		"id": `${file}#${f.name}`,
		"file": file,
		"hash": sha(src.slice(f.start, f.end)),
		"startLine": lineAt(starts, f.start),
		"endLine": lineAt(starts, f.end)
	}));

	// the module glue = source with every function span removed
	let glue = "";
	let cursor = 0;

	for (const f of fns) { glue += src.slice(cursor, f.start); cursor = f.end; }
	glue += src.slice(cursor);

	units.push({ "id": `${file}#<module>`, "file": file, "hash": sha(glue), "startLine": 0, "endLine": 0 });

	return units;
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

	try {
		ingest(execSync(cmd, { "cwd": ROOT, "encoding": "utf8", "stdio": ["ignore", "pipe", "ignore"], "maxBuffer": 64 * 1024 * 1024 }));
	} catch (error) {
		const stdout = (error as { "stdout"?: string }).stdout;   // eslint exits non-zero WITH json on stdout

		if (stdout) { ingest(stdout); }
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

/** unreviewed (never signed) ≻ stale (signed, then edited) ≻ waived (accepted unread) ≻ reviewed (read). */
function understoodOf(rec: ReviewRecord | undefined, hash: string): Understood {
	return rec === undefined ? "unreviewed" : rec.hash !== hash ? "stale" : rec.waived === true ? "waived" : "reviewed";
}

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
	return review.filter((u) => touched.has(u.id) && exposed.has(u.file) && u.understood !== "reviewed" && u.understood !== "waived");
}

/** Record the human sign-off for a unit (`file#fn`) or every unit in a file. Returns what it marked. */
export async function markReviewed(target: string, waived = false): Promise<Unit[]> {
	const store = loadStore();
	const [rawFile, fn] = target.split("#");
	const file = path.relative(ROOT, path.resolve(rawFile));
	const marked = unitsOf(file).filter((u) => fn === undefined || u.id === `${file}#${fn}`);

	for (const u of marked) { store[u.id] = { "hash": u.hash, "at": new Date().toISOString(), ...(waived ? { "waived": true } : {}) }; }
	if (marked.length) { await saveStore(store); }

	return marked;
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
