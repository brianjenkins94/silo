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

/** `waived` = consciously accepted WITHOUT reading it. Satisfies the gate but is NOT trust; hash-anchored
 *  like a review, so editing the unit raises it again. */
export type Understood = "reviewed" | "waived" | "stale" | "unreviewed";

/** A review store record — `.silo/review.json` is `Record<unitId, ReviewRecord>`. */
export interface ReviewRecord { "hash": string; "note"?: string; "at": string; "waived"?: boolean }
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

/** Split+hash units from SOURCE TEXT: each function span, plus `#<module>` = what's left over (imports,
 *  constants, top-level side effects) once the function spans are cut out. Every byte lands in one unit. */
export function unitsOfSource(file: string, src: string): Unit[] {
	const starts = lineIndex(src);
	const fns = spans(file, src);

	const units: Unit[] = fns.map((f) => ({
		"id": `${file}#${f.name}`,
		"file": file,
		"hash": sha(src.slice(f.start, f.end)),
		"startLine": lineAt(starts, f.start),
		"endLine": lineAt(starts, f.end)
	}));

	let glue = "";
	let cursor = 0;

	for (const f of fns) { glue += src.slice(cursor, f.start); cursor = f.end; }
	glue += src.slice(cursor);

	units.push({ "id": `${file}#<module>`, "file": file, "hash": sha(glue), "startLine": 0, "endLine": 0 });

	return units;
}

/** unreviewed (never signed) ≻ stale (signed, then edited) ≻ waived (accepted unread) ≻ reviewed (read). */
export function understoodOf(rec: ReviewRecord | undefined, hash: string): Understood {
	return rec === undefined ? "unreviewed" : rec.hash !== hash ? "stale" : rec.waived === true ? "waived" : "reviewed";
}
