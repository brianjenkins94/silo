/**
 * The session engine: the set of unit transforms between two clean snapshots (baseline → final). Pure — no fs,
 * git, or AI. The CLI diffs git-base vs working tree; the extension diffs a focus-time snapshot vs the approved
 * state. It only REDUCES (deterministic set-diff over unit identity); interpreting what the transforms mean is
 * the corpus consumer's job. Runs anywhere review-core does (native oxc in Node, oxc-wasm in the browser core).
 */
import { parseSync } from "oxc-parser";
import { unitsOfSource } from "./review-core.js";

export type SessionAction = "added" | "dead-code-removed" | "deleted" | "edited" | "extracted" | "inlined" | "moved";

const fnName = (id: string) => { const hash = id.indexOf("#"); return hash >= 0 ? id.slice(hash + 1) : id; };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const callsName = (src: string, name: string) => new RegExp(`(?<![.\\w])${escapeRe(name)}\\s*\\(`, "u").test(src);

/** A "pointless wrapper": a function whose whole body is a single forwarded call (`() => g(x)`, `{ return g(x); }`,
 *  or `{ g(x); }`). Deleting one of these + rewiring its callers is an INLINE, not a plain deletion. */
function isPassThrough(src: string): boolean {
	try {
		// eslint-disable-next-line ts/no-explicit-any
		const { program } = parseSync("u.ts", src) as { "program": any };
		// eslint-disable-next-line ts/no-explicit-any
		let fn: any;

		// eslint-disable-next-line ts/no-explicit-any
		for (const stmt of (program.body ?? []) as any[]) {
			const decl = stmt.type?.startsWith("Export") ? (stmt.declaration ?? stmt) : stmt;

			if (decl?.type === "FunctionDeclaration") { fn = decl; break; }
			if (decl?.type === "VariableDeclaration") { const v = decl.declarations?.[0]; if (v?.init?.type === "ArrowFunctionExpression" || v?.init?.type === "FunctionExpression") { fn = v.init; break; } }
		}

		const body = fn?.body;

		if (body?.type === "CallExpression") { return true; }   // arrow expression body: () => g(x)
		const stmts = body?.body;

		if (Array.isArray(stmts) && stmts.length === 1) {
			const s = stmts[0];

			return (s.type === "ReturnStatement" && s.argument?.type === "CallExpression") || (s.type === "ExpressionStatement" && s.expression?.type === "CallExpression");
		}

		return false;
	} catch { return false; }
}

export interface Transform {
	"id": string;          // the unit's final id (its baseline id for a deletion)
	"action": SessionAction;
	"from"?: string;       // moved: the baseline id
	"before"?: string;     // baseline source (omitted for added)
	"after"?: string;      // final source (omitted for deleted)
}

interface UnitState { "source": string; "hash": string }

/** Function units of a file with source sliced by line range. The range includes the leading comment (so a
 *  de-comment shows up in before→after); the `#<module>` glue unit has no range and is skipped. */
function fileUnits(file: string, src: string): Map<string, UnitState> {
	const lines = src.split("\n");
	const out = new Map<string, UnitState>();

	for (const unit of unitsOfSource(file, src)) {
		if (unit.endLine <= 0) { continue; }
		out.set(unit.id, { "source": lines.slice(unit.startLine - 1, unit.endLine).join("\n"), "hash": unit.hash });
	}

	return out;
}

function collect(files: Record<string, string>): Map<string, UnitState> {
	const all = new Map<string, UnitState>();

	for (const [file, src] of Object.entries(files)) { for (const [id, state] of fileUnits(file, src)) { all.set(id, state); } }

	return all;
}

/** Transforms taking `baseline` → `final` (both file→source maps). edited/deleted/added by unit-id set-diff;
 *  moved = a baseline-only unit whose code-hash reappears at EXACTLY ONE final-only id (unique-match keeps it
 *  precise — an ambiguous hash falls back to delete + add rather than guessing). */
export function sessionTransforms(baseline: Record<string, string>, final: Record<string, string>): Transform[] {
	const base = collect(baseline);
	const fin = collect(final);
	const out: Transform[] = [];

	const finalOnlyByHash = new Map<string, string[]>();

	for (const [id, s] of fin) {
		if (base.has(id)) { continue; }
		const list = finalOnlyByHash.get(s.hash);

		if (list === undefined) { finalOnlyByHash.set(s.hash, [id]); } else { list.push(id); }
	}

	const movedTo = new Set<string>();

	for (const [id, b] of base) {
		if (fin.has(id)) { continue; }
		const hits = finalOnlyByHash.get(b.hash);

		if (hits !== undefined && hits.length === 1 && !movedTo.has(hits[0])) {
			out.push({ "id": hits[0], "action": "moved", "from": id, "before": b.source, "after": fin.get(hits[0])?.source });
			movedTo.add(hits[0]);
		} else {
			// Refine a deletion: no callers in baseline → dead code; a pass-through wrapper whose callers no
			// longer call it → an inline; otherwise a plain deletion.
			const name = fnName(id);
			const hadCallers = [...base].some(([cid, cs]) => cid !== id && callsName(cs.source, name));
			const stillCalled = [...fin].some(([, fs]) => callsName(fs.source, name));
			const action: SessionAction = !hadCallers ? "dead-code-removed" : isPassThrough(b.source) && !stillCalled ? "inlined" : "deleted";

			out.push({ "id": id, "action": action, "before": b.source });
		}
	}

	for (const [id, f] of fin) {
		if (movedTo.has(id)) { continue; }
		const b = base.get(id);

		if (b === undefined) { out.push({ "id": id, "action": "added", "after": f.source }); } else if (b.hash !== f.hash) { out.push({ "id": id, "action": "edited", "before": b.source, "after": f.source }); }
	}

	// Refine additions: a new unit that an EDITED unit now calls was EXTRACTED from it (inverse of inline).
	const editedAfter = out.filter((t) => t.action === "edited").map((t) => t.after ?? "");

	for (const t of out) {
		if (t.action === "added" && editedAfter.some((src) => callsName(src, fnName(t.id)))) { t.action = "extracted"; }
	}

	return out;
}

export interface AttributedTransform extends Transform { "attribution": "direct" | "related" | "incidental" }

/** Transforms with call-graph attribution to the focal unit: `direct` (the focal unit itself), `related` (a
 *  1-hop call neighbour — the focal calls it, or it calls the focal, in either before or after), else
 *  `incidental` (co-changed but not connected). Textual `name(` edges, not the LSP: precise on call syntax,
 *  misses aliasing/callbacks/methods (precision over recall). Cross-file-capable — pass more files to reach
 *  callers in other files. */
export function attributedTransforms(focalId: string, baseline: Record<string, string>, final: Record<string, string>): AttributedTransform[] {
	const transforms = sessionTransforms(baseline, final);
	const focalName = fnName(focalId);
	const focalSrc = [collect(baseline).get(focalId)?.source, collect(final).get(focalId)?.source].filter(Boolean).join("\n");

	return transforms.map((t) => {
		if (t.id === focalId) { return { ...t, "attribution": "direct" }; }
		const otherSrc = [t.before, t.after].filter(Boolean).join("\n");

		return { ...t, "attribution": callsName(focalSrc, fnName(t.id)) || callsName(otherSrc, focalName) ? "related" : "incidental" };
	});
}
