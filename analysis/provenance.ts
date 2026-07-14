/**
 * PROTOTYPE — provenance heuristic: estimate how likely a source file was AI-authored. Two signals, no
 * arbitrary phrase-matching:
 *
 *   1. STRUCTURAL (the workhorse) — big, non-JSDoc prose documentation blocks sitting directly in front
 *      of functions / classes / methods. LLMs habitually preface each declaration with a multi-line
 *      explanatory paragraph that is NOT a tagged JSDoc comment. A block carrying `@param`/`@returns`-
 *      style tags is treated as JSDoc and ignored — so this heuristic deliberately can't distinguish
 *      AI in a codebase that writes real JSDoc (an accepted limitation).
 *   2. ATTRIBUTION MARKERS — explicit "Co-authored-by: Claude" / "AI-generated" left in comments. The
 *      git-trailer form of this (a far better but low-recall signal — people strip it, or Claude never
 *      touches git) is `gitCoauthoredFiles`, merged in by the caller (see cli.ts audit).
 *
 * Comments come from oxc's parse, so strings that merely look like comments never count. This is a
 * SMOKE DETECTOR, not a polygraph — a human who writes prose doc-blocks will trip it.
 *
 *   tsx analysis/provenance.ts <file|dir> [--json] [--git]
 */
import { spawnSync } from "node:child_process";
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
import { parseSync } from "oxc-parser";

export type Verdict = "clean" | "possible" | "likely";

export interface Signal { "name": string; "matches": number; "sample": string }
export interface Provenance { "score": number; "verdict": Verdict; "signals": Signal[]; "functions": number; "documented": number }

// The structural tell is doc-comment COVERAGE: AI puts a comment in front of nearly every function, terse
// or not, while humans document selectively — so the signal is the FRACTION of a file's functions carrying
// a non-JSDoc doc comment. Any function count qualifies (a lone documented function reads AI); only a file
// with ZERO detected functions can't be scored this way. Tagged JSDoc (@param/@returns) doesn't count:
// those authors are deliberately undetectable here.
const LIKELY_RATIO = 0.7;
const POSSIBLE_RATIO = 0.4;
// A JSDoc tag is an `@word` at the START of a comment line (after optional ` * `) — `@param`, `@returns`.
// Must NOT match an inline scoped-package mention like `@typescript/native-preview` or `@brianjenkins94`,
// which appear mid-sentence (that false match was silently exempting most commented functions).
const JSDOC_TAG = /(?:^|\n)\s*(?:\*\s*)?@\w+/u;
const MARKER = /co-?authored-?by:\s*claude|generated (?:with|by) (?:an? )?(?:ai|claude)|\bai[- ]generated\b|chatgpt|gpt-\d|github copilot/iu;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Group comments that sit back-to-back (only whitespace between) into single blocks — so a run of `//`
 *  lines, or one `/* … *​/`, is one doc block. */
function commentBlocks(comments: { "start": number; "end": number; "value": string }[], src: string) {
	const sorted = [...comments].sort((a, b) => a.start - b.start);
	const blocks: { "start": number; "end": number; "text": string }[] = [];

	for (const c of sorted) {
		const last = blocks[blocks.length - 1];

		if (last && /^\s*$/u.test(src.slice(last.end, c.start))) { last.end = c.end; last.text += "\n" + c.value; } else { blocks.push({ "start": c.start, "end": c.end, "text": c.value }); }
	}

	return blocks;
}

/** Start offsets of every "documentable" declaration: top-level functions/classes (incl. exported and
 *  `const f = () => …`) plus class methods. The offset is the STATEMENT start, so a leading comment sits
 *  in whitespace just above it (no `export`/`async` keyword in the gap). */
function declStarts(program: any): number[] {
	const out: number[] = [];
	const isFn = (d: any) => d && (d.type === "FunctionDeclaration" || d.type === "TSDeclareFunction" || d.type === "ClassDeclaration");
	const isVarFn = (d: any) => d && d.type === "VariableDeclaration" && d.declarations?.some((v: any) => v.init && (v.init.type === "ArrowFunctionExpression" || v.init.type === "FunctionExpression"));

	for (const stmt of program.body as any[]) {
		const decl = stmt.type?.startsWith("Export") ? (stmt.declaration ?? stmt) : stmt;

		if (isFn(decl) || isVarFn(decl)) { out.push(stmt.start); }
		if (decl?.type === "ClassDeclaration") {
			for (const m of decl.body?.body ?? []) {
				if (m.type === "MethodDefinition") { out.push(m.start); }
			}
		}
	}

	return out;
}

/** Score a source string. Pure (no disk/git) so it can be unit-tested directly. */
export function scoreSource(file: string, src: string): Provenance {
	const { program, comments = [] } = parseSync(file, src) as any;
	const blocks = commentBlocks(comments, src);
	const starts = declStarts(program);

	// Attribution marker anywhere in comments → near-certain.
	let markerSample = "";

	for (const c of comments) {
		const m = MARKER.exec(c.value);

		if (m) { markerSample = m[0].trim(); break; }
	}

	// For each declaration, does a NON-JSDoc comment sit directly above it (on its own line, only
	// whitespace between)? Length doesn't matter — a one-line `/** … */` counts. The signal is how MANY of
	// the file's functions are documented this way, not how verbose any one comment is. A `@param`/`@returns`
	// (JSDoc) block doesn't count — those authors are exempt.
	let docSample = ""; let
		documented = 0;

	for (const start of starts) {
		let lead: { "start": number; "end": number; "text": string } | undefined;

		for (const b of blocks) { if (b.end <= start) { lead = b; } else { break; } }
		if (!lead || !/^\s*$/u.test(src.slice(lead.end, start))) { continue; }       // must sit directly above
		if (!/(?:^|\n)[ \t]*$/u.test(src.slice(0, lead.start))) { continue; }        // …and start its own line (not a trailing comment)
		if (JSDOC_TAG.test(lead.text)) { continue; }
		documented++;
		if (!docSample) { docSample = lead.text.replace(/\s+/gu, " ").trim().slice(0, 50); }
	}

	const functions = starts.length;
	const ratio = functions ? documented / functions : 0;
	const signals: Signal[] = [];

	if (markerSample) { signals.push({ "name": "marker", "matches": 1, "sample": markerSample.slice(0, 60) }); }
	if (documented) { signals.push({ "name": "doc-coverage", "matches": documented, "sample": `${documented}/${functions} fns — “${docSample}”` }); }

	const verdict: Verdict = markerSample ? "likely"
		: functions >= 1 && ratio >= LIKELY_RATIO ? "likely"
			: functions >= 1 && ratio >= POSSIBLE_RATIO ? "possible"
				: "clean";
	const score = markerSample ? 1 : round2(ratio);

	return { "score": score, "verdict": verdict, "signals": signals, "functions": functions, "documented": documented };
}

export function analyzeFile(file: string): Provenance {
	return scoreSource(file, fs.readFileSync(file));
}

/** Files touched by any commit carrying a Claude/AI `Co-authored-by:` trailer — a high-confidence,
 *  low-recall signal the caller can merge in (returns ABSOLUTE paths; empty outside a git repo). */
export function gitCoauthoredFiles(cwd: string = process.cwd()): Set<string> {
	const out = new Set<string>();

	try {
		const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { "encoding": "utf8" });

		if (top.status !== 0) { return out; }
		const root = top.stdout.trim();
		const r = spawnSync("git", ["-C", cwd, "log", "--no-merges", "--format=%H\t%(trailers:key=Co-authored-by,valueonly,separator=%x2C)", "--name-only"], { "encoding": "utf8", "maxBuffer": 64 * 1024 * 1024 });

		if (r.status !== 0) { return out; }
		let aiCommit = false;

		for (const line of r.stdout.split("\n")) {
			const head = /^([0-9a-f]{40})\t(.*)$/u.exec(line);

			if (head) { aiCommit = MARKER.test(head[2]); continue; }
			if (aiCommit && line.trim()) { out.add(path.join(root, line.trim())); }
		}
	} catch { /* git missing / not a repo */ }

	return out;
}

// ── CLI ──
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

async function files(target: string): Promise<string[]> {
	const st = await fs.stat(target);

	if (st.isFile()) { return [target]; }
	const out: string[] = [];

	for (const e of await fs.readdir(target, { "withFileTypes": true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) { continue; }
		const p = path.join(target, e.name);

		if (e.isDirectory()) { out.push(...(await files(p))); } else if (CODE.test(e.name)) { out.push(p); }
	}

	return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const JSON_MODE = process.argv.includes("--json");
	const target = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? ".";
	const git = process.argv.includes("--git") ? gitCoauthoredFiles() : new Set<string>();
	const results = (await files(path.resolve(target))).map((f) => {
		const prov = analyzeFile(f);

		if (git.has(path.resolve(f)) && prov.verdict !== "likely") { prov.verdict = "likely"; prov.score = 1; prov.signals.push({ "name": "git:co-author", "matches": 1, "sample": "Co-authored-by trailer" }); }

		return { "file": path.relative(process.cwd(), f), ...prov };
	});

	if (JSON_MODE) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		const mark = { "likely": "●", "possible": "◐", "clean": "○" } as const;
		const ranked = results.filter((r) => r.verdict !== "clean").sort((a, b) => b.score - a.score);

		console.log(`provenance: ${target}   (${results.length} files, ${ranked.length} flagged)\n`);
		if (!ranked.length) { console.log("  ○ no AI-authorship signals"); }
		for (const r of ranked) {
			console.log(`  ${mark[r.verdict]} ${r.verdict.padEnd(8)} ${r.score.toFixed(2)}  ${r.file}   (${r.documented}/${r.functions} fns documented)`);
			for (const s of r.signals) { console.log(`        ${s.name.padEnd(12)} ${s.matches}×  “${s.sample}”`); }
		}
	}
}
