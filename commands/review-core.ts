/**
 * The PURE core of silo's quality/review axis — no git, no fs, no eslint, no `process`, no top-level
 * side effects. It takes SOURCE TEXT in and returns the hash-anchored units + their review state.
 *
 * This is the part of the review engine that runs in BOTH environments:
 *   • the CLI (commands/review.ts) injects the Node impls — reads files via fs, scopes via git;
 *   • the browser extension (vscode/extensions/silo) bundles it with oxc-parser's `browser` build
 *     (src-js/wasm.js, a drop-in `parseSync`) and a sync sha shim, and feeds it document text.
 *
 * Both sides get the SAME unit ids, the SAME hashes, and the SAME `understood` logic — so the overlay
 * is literally running silo, not a lookalike. Keep this file free of anything that isn't pure over its
 * inputs, or it stops being portable.
 */
import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { redactSecrets } from "./redact.js";

/** `waived` = consciously accepted WITHOUT reading it. Satisfies the gate but is NOT trust; hash-anchored
 *  like a review, so editing the unit raises it again. */
export type Understood = "reviewed" | "waived" | "stale" | "unreviewed";

/** A review store record — `.silo/review.json` is `Record<unitId, ReviewRecord>`. `fp` = per-statement
 *  fingerprints of the approved code (see fingerprintsOfSource) — hashes only, so a re-review can locate what
 *  changed without any source on disk. */
export interface ReviewRecord { "hash": string; "note"?: string; "at": string; "waived"?: boolean; "fp"?: [string, string][] }
export type ReviewStore = Record<string, ReviewRecord>;

export interface Unit {
	"id": string;            // `<file>#<fn>` — `#<module>` = the file's top-level glue
	"file": string;
	"hash": string;
	"startLine": number;
	"endLine": number;
}

/** sha-256 of the text, first 12 hex chars — silo's unit hash. (createHash is sync in Node; the browser
 *  build aliases `node:crypto` to a sync sha shim so this stays synchronous in both.) */
export const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

const POSITION_KEYS = new Set(["start", "end", "range", "loc", "span"]);

/** A structural fingerprint of an AST node (or array of nodes): the parse tree with every position field
 *  stripped and object keys sorted. So re-indentation, operator spacing, and line breaks don't change it — but
 *  string/template CONTENTS, structure, and anything the parser resolves (ASI, regex-vs-divide) do. Hashing
 *  this instead of raw source is what lets a reformat (e.g. spaces→tabs) survive without re-gating every
 *  reviewed unit. Key-sorting keeps it stable across oxc's native (CLI) vs wasm (browser) object emission. */
function canonical(node: unknown): string {
	// eslint-disable-next-line ts/no-explicit-any
	return JSON.stringify(node, (key: string, value: any) => {
		if (POSITION_KEYS.has(key)) { return undefined; }
		if (typeof value === "bigint") { return value.toString(); }

		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			// eslint-disable-next-line ts/no-explicit-any
			const sorted: Record<string, any> = {};

			for (const k of Object.keys(value).sort()) { sorted[k] = value[k]; }

			return sorted;
		}

		return value;
	});
}

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

/** Top-level functions / arrow-consts / class methods. `node` is the AST subtree to fingerprint (the whole
 *  statement for decls/arrow-consts, the method for class members); `stmt` is the owning top-level statement
 *  (so the module glue can exclude everything already claimed by a unit); `start`/`end` are byte offsets for
 *  the display range. */
interface Span { "name": string; "node": any; "stmt": any; "start": number; "end": number }

function spans(program: any): Span[] {
	const out: Span[] = [];

	for (const stmt of (program.body ?? []) as any[]) {
		const decl = stmt.type?.startsWith("Export") ? (stmt.declaration ?? stmt) : stmt;

		if (decl?.type === "FunctionDeclaration" || decl?.type === "TSDeclareFunction") {
			out.push({ "name": decl.id?.name ?? "(anonymous)", "node": stmt, "stmt": stmt, "start": stmt.start, "end": stmt.end });
		} else if (decl?.type === "VariableDeclaration") {
			for (const v of decl.declarations ?? []) {
				if (v.init && (v.init.type === "ArrowFunctionExpression" || v.init.type === "FunctionExpression")) {
					out.push({ "name": v.id?.name ?? "(anonymous)", "node": stmt, "stmt": stmt, "start": stmt.start, "end": stmt.end });
				}
			}
		} else if (decl?.type === "ClassDeclaration") {
			const cls = decl.id?.name ?? "(class)";

			for (const m of decl.body?.body ?? []) {
				if (m.type === "MethodDefinition") { out.push({ "name": `${cls}.${m.key?.name ?? "?"}`, "node": m, "stmt": stmt, "start": m.start, "end": m.end }); }
			}
		}
	}

	return out.sort((a, b) => a.start - b.start);
}

/** Extend a unit's DISPLAY start up over the doc/leading comment block directly above the declaration
 *  (contiguous, no blank line) — so review + decorations include the comment. The HASH still covers only the
 *  code, so editing just the comment doesn't re-gate. `floor` stops it crossing into the previous unit. */
function withLeadingComments(src: string, comments: { "start": number; "end": number }[], declStart: number, floor: number): number {
	let start = declStart;

	for (const c of comments.filter((x) => x.end <= declStart && x.start >= floor).sort((a, b) => b.start - a.start)) {
		const gap = src.slice(c.end, start);

		if (/\S/u.test(gap) || /\n[ \t]*\n/u.test(gap)) { break; }   // code, or a blank line → not this unit's doc
		start = c.start;
	}

	return start;
}

/** Split+hash units from SOURCE TEXT: each function span, plus `#<module>` = what's left over (imports,
 *  constants, top-level side effects) once the function statements are removed. The hash is a STRUCTURAL
 *  fingerprint of the AST (see `canonical`) — formatting-insensitive — not the raw bytes; a unit's line range
 *  still covers its leading comment (see withLeadingComments). */
export function unitsOfSource(file: string, src: string): Unit[] {
	const { program, comments = [] } = parseSync(file, src) as any;
	const starts = lineIndex(src);
	const fns = spans(program);

	const units: Unit[] = fns.map((f, i) => ({
		"id": `${file}#${f.name}`,
		"file": file,
		"hash": sha(canonical(f.node)),
		"startLine": lineAt(starts, withLeadingComments(src, comments, f.start, i > 0 ? fns[i - 1].end : 0)),
		"endLine": lineAt(starts, f.end)
	}));

	// `#<module>` = the top-level statements no function unit claimed (imports, constants, side effects).
	const claimed = new Set(fns.map((f) => f.stmt));
	const glue = ((program.body ?? []) as any[]).filter((stmt) => !claimed.has(stmt));

	units.push({ "id": `${file}#<module>`, "file": file, "hash": sha(canonical(glue)), "startLine": 0, "endLine": 0 });

	return units;
}

// Literal node types whose text we redact (full) or drop (shape) when fingerprinting — so a secret never
// becomes a persisted per-statement hash, and formatting-only literal churn doesn't read as a change.
const LITERAL_TYPES = new Set(["Literal", "StringLiteral", "NumericLiteral", "BigIntLiteral", "BooleanLiteral", "NullLiteral", "RegExpLiteral"]);

/** Structural JSON of ONE statement for fingerprinting. `strip` = shape mode: drop all literal text, leaving
 *  only structure. Otherwise full mode: keep values, but run string literals through redactSecrets so a
 *  hardcoded secret never lands in a persisted hash. Positions stripped + keys sorted, like `canonical`. */
function fingerprintJSON(node: unknown, strip: boolean): string {
	// eslint-disable-next-line ts/no-explicit-any
	return JSON.stringify(node, function(this: any, key: string, value: any) {
		if (POSITION_KEYS.has(key)) { return undefined; }
		if (typeof value === "bigint") { return value.toString(); }

		// Literal text lives at Literal.value / .raw and TemplateElement.value.{raw,cooked}.
		if (key === "raw" || key === "cooked" || (key === "value" && LITERAL_TYPES.has(this.type))) {
			if (strip) { return typeof value === "object" ? undefined : typeof value; }

			return typeof value === "string" ? redactSecrets(value) : value;
		}

		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			// eslint-disable-next-line ts/no-explicit-any
			const sorted: Record<string, any> = {};

			for (const k of Object.keys(value).sort()) { sorted[k] = value[k]; }

			return sorted;
		}

		return value;
	});
}

// Per-statement fingerprints keep only the PREFIX of each hash. Detection stays reliable (collisions only
// matter within one unit's handful of statements), but a truncated hash has many colliding preimages — so
// brute-forcing a literal back out of it yields ambiguous candidates, not the value. Discourages, doesn't
// prevent: a determined attack on a low-entropy literal is still possible (which is why redactSecrets also
// runs on the full hash for known secret formats). Tune here.
const FP_HASH_LEN = 6;
const short = (h: string): string => h.slice(0, FP_HASH_LEN);
const fpOf = (stmt: unknown): [string, string] => [short(sha(fingerprintJSON(stmt, false))), short(sha(fingerprintJSON(stmt, true)))];

/** The statements that make up a unit's body — what we fingerprint individually to locate a change later. */
// eslint-disable-next-line ts/no-explicit-any
function bodyStatements(node: any): any[] {
	const decl = node?.type?.startsWith("Export") ? (node.declaration ?? node) : node;

	if (decl?.type === "FunctionDeclaration" || decl?.type === "TSDeclareFunction") { return decl.body?.body ?? []; }
	if (decl?.type === "MethodDefinition") { return decl.value?.body?.body ?? []; }
	if (decl?.type === "VariableDeclaration") {
		const init = decl.declarations?.[0]?.init;

		if (init?.body?.type === "BlockStatement") { return init.body.body ?? []; }

		return init ? [init] : [];   // expression-bodied arrow → the expression is the single "statement"
	}

	return [];
}

/** Per-unit statement fingerprints for SOURCE: `[fullHash, shapeHash]` per body statement. Captured at review
 *  time and stored in the record so a later re-review can locate exactly what changed (see locateChanges) —
 *  hashes only, no source persisted. Not called on the hot path; only on sign-off. */
export function fingerprintsOfSource(file: string, src: string): Record<string, [string, string][]> {
	// eslint-disable-next-line ts/no-explicit-any
	const { program } = parseSync(file, src) as any;
	const fns = spans(program);
	const claimed = new Set(fns.map((f) => f.stmt));
	const out: Record<string, [string, string][]> = {};

	for (const f of fns) { out[`${file}#${f.name}`] = bodyStatements(f.node).map(fpOf); }
	// eslint-disable-next-line ts/no-explicit-any
	out[`${file}#<module>`] = ((program.body ?? []) as any[]).filter((s) => !claimed.has(s)).map(fpOf);

	return out;
}

export interface ChangedStatement { "startLine": number; "endLine": number; "kind": "structural" | "value" }

/** The re-review locator: given a unit's CURRENT source and the fingerprints stored when it was last reviewed,
 *  return the statements that changed since — their current line ranges, and whether it's a `value`-only edit
 *  (structure intact, a literal moved) or a `structural` one. Works from hashes alone; no stored source. */
export function locateChanges(file: string, src: string, unitId: string, storedFp: readonly [string, string][]): ChangedStatement[] {
	// eslint-disable-next-line ts/no-explicit-any
	const { program } = parseSync(file, src) as any;
	const fns = spans(program);
	const claimed = new Set(fns.map((f) => f.stmt));
	const fn = fns.find((f) => `${file}#${f.name}` === unitId);
	// eslint-disable-next-line ts/no-explicit-any
	const stmts: any[] = fn ? bodyStatements(fn.node) : unitId.endsWith("#<module>") ? ((program.body ?? []) as any[]).filter((s) => !claimed.has(s)) : [];
	const storedFull = new Set(storedFp.map((x) => x[0]));
	const storedShape = new Set(storedFp.map((x) => x[1]));
	const starts = lineIndex(src);
	const out: ChangedStatement[] = [];

	for (const stmt of stmts) {
		if (storedFull.has(short(sha(fingerprintJSON(stmt, false))))) { continue; }   // unchanged since review
		out.push({ "startLine": lineAt(starts, stmt.start), "endLine": lineAt(starts, stmt.end), "kind": storedShape.has(short(sha(fingerprintJSON(stmt, true)))) ? "value" : "structural" });
	}

	return out;
}

/** unreviewed (never signed) ≻ stale (signed, then edited) ≻ waived (accepted unread) ≻ reviewed (read). */
export function understoodOf(rec: ReviewRecord | undefined, hash: string): Understood {
	return rec === undefined ? "unreviewed" : rec.hash !== hash ? "stale" : rec.waived === true ? "waived" : "reviewed";
}
