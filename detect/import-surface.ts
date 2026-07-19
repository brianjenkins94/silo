/**
 * PROTOTYPE — `surface`: the CONSUMER-side capability surface (member-level binding analysis).
 *
 *   tsx import-surface.ts <file|dir> [--json]
 *
 * For the user's OWN code, this answers "what do I actually import and use from each dependency?" —
 * the member-level surface that the npm-boundary model is built on. Distinct from cap-*.ts (which
 * analyze what code CAN do); this is the *interface* axis: which exports of a dep my code touches.
 *
 * Real binding analysis, not regex — handles named / default / namespace imports, aliases, and
 * member access on a namespace import (`import * as _; _.get(...)` → member `get`). Computed access
 * (`_[x]`) is recorded as `*` — a first-class "indeterminate reach" signal, same convention as cap-*.
 *
 * v1 LIMITATION: matches binding locals by name within the file; does not yet resolve local
 * shadowing of an import name (rare). v2: scope-resolved references (oxc semantic / tsgo LSP).
 */
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
// The PURE analysis kernel — shared with a browser capability view (see detect/analysis-core.ts). This
// file is the NODE orchestration around it: fs file-walking + node_modules version resolution.
import { type Surface, add, classifyKind, surfaceOfSource } from "./analysis-core.js";

export type { SurfaceEntry } from "./analysis-core.js";   // re-export for consumers (audit.ts)

/** Classify a specifier and, for real deps, resolve the installed version from node_modules. Kind is the
 *  pure part (analysis-core.classifyKind); version resolution is Node-only. */
export function classify(spec: string, fromDir: string, stopRoot: string = fromDir): { "kind": "builtin" | "package" | "local"; "pkg"?: string; "version"?: string } {
	const kind = classifyKind(spec);

	if (kind.kind !== "package") { return kind; }
	const pkg = kind.pkg as string;

	// Walk node_modules up from the workspace dir to the project root: a workspace-local version wins,
	// else the hoisted root one — so non-hoisted monorepos resolve the version each package actually has.
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const pj = path.join(d, "node_modules", pkg, "package.json");

		if (fs.existsSync(pj)) { try { return { "kind": "package", "pkg": pkg, "version": JSON.parse(fs.readFileSync(pj)).version }; } catch { break; } }
		if (d === stop || d === path.dirname(d)) { break; }
	}

	return { "kind": "package", "pkg": pkg };
}

const isCode = (f: string) => /\.(m|c)?[jt]sx?$/.test(f);

/** The consumer surface of a file — reads it, then delegates to the pure kernel. */
export function analyze(file: string): Surface {
	return surfaceOfSource(file, fs.readFileSync(file));
}

/** A directory that is its own package and is marked `private: true`. Such NESTED workspaces are
 *  silo-ignored everywhere — a private subproject (e.g. a vscode-in-browser playground) carries its own
 *  deps and isn't governed by the enclosing project's baseline. The audit *target* itself is never tested
 *  here (see `files`), so `cd examples/ci-demo && silo audit` still works even when ci-demo is private. */
function isPrivateWorkspace(dir: string): boolean {
	const pj = path.join(dir, "package.json");

	if (!fs.existsSync(pj)) { return false; }
	try { return JSON.parse(fs.readFileSync(pj))["private"] === true; } catch { return false; }
}

async function files(target: string): Promise<string[]> {
	const st = await fs.stat(target);

	if (st.isFile()) { return [target]; }
	const out: string[] = [];

	for (const e of await fs.readdir(target, { "withFileTypes": true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) { continue; }
		const p = path.join(target, e.name);

		// Descend into subdirectories, but prune a nested private workspace (it self-governs).
		if (e.isDirectory()) { if (!isPrivateWorkspace(p)) { out.push(...(await files(p))); } } else if (isCode(e.name)) { out.push(p); }
	}

	return out;
}

/** Merge every code file under `target` into one consumer surface (specifier → members). */
export async function projectSurface(target: string): Promise<{ "perFile": Record<string, Record<string, SurfaceEntry>>; "surface": Record<string, SurfaceEntry> }> {
	const merged: Surface = new Map();
	const perFile: Record<string, Record<string, SurfaceEntry>> = {};

	for (const f of await files(path.resolve(target))) {
		const s = analyze(f);

		perFile[path.relative(process.cwd(), f)] = Object.fromEntries([...s].map(([k, v]) => [k, { "members": [...v.members].sort(), "dynamic": v.dynamic }]));
		for (const [spec, use] of s) { for (const m of use.members) { add(merged, spec, m); } if (use.dynamic) { add(merged, spec, "", true); } }
	}

	return { "perFile": perFile, "surface": Object.fromEntries([...merged].map(([k, v]) => [k, { "members": [...v.members].sort(), "dynamic": v.dynamic }])) };
}

/** Nearest enclosing package (a file's "workspace"), as a path relative to `root` ("." for root code). */
function owningWorkspace(file: string, root: string): string {
	const rootAbs = path.resolve(root);

	for (let d = path.dirname(path.resolve(file)); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "package.json"))) { return path.relative(rootAbs, d) || "."; }
		if (d === rootAbs || d === path.dirname(d)) { return "."; }
	}
}

/** Like projectSurface, but partitioned by workspace (nearest package.json) — so a monorepo audit can
 *  attribute each dep's usage to the package that imports it, keyed by path relative to `root`. */
export async function workspaceSurfaces(target: string, root: string): Promise<Record<string, Record<string, SurfaceEntry>>> {
	const buckets = new Map<string, Surface>();

	for (const f of await files(path.resolve(target))) {
		const ws = owningWorkspace(f, root);
		const bucket = buckets.get(ws) ?? new Map();

		buckets.set(ws, bucket);
		for (const [spec, use] of analyze(f)) {
			for (const m of use.members) { add(bucket, spec, m); }
			if (use.dynamic) { add(bucket, spec, "", true); }
		}
	}

	const out: Record<string, Record<string, SurfaceEntry>> = {};

	for (const [ws, surface] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) { out[ws] = Object.fromEntries([...surface].map(([k, v]) => [k, { "members": [...v.members].sort(), "dynamic": v.dynamic }])); }

	return out;
}

/** Per workspace, which files import each specifier — so the audit can attribute a drifting capability
 *  back to the source file(s) that brought it in (e.g. to flag that a new cap entered via AI-authored
 *  code). Same walk/keys as `workspaceSurfaces` (nested private workspaces pruned); file paths are
 *  relative to cwd. */
export async function workspaceImporters(target: string, root: string): Promise<Record<string, Record<string, string[]>>> {
	const out: Record<string, Record<string, string[]>> = {};

	for (const f of await files(path.resolve(target))) {
		const ws = owningWorkspace(f, root);
		const rel = path.relative(process.cwd(), f);
		const byWs = out[ws] ??= {};

		for (const spec of analyze(f).keys()) { (byWs[spec] ??= []).push(rel); }
	}

	return out;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
	const JSON_MODE = process.argv.includes("--json");
	const target = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? ".";
	const { perFile, surface } = await projectSurface(target);

	if (JSON_MODE) {
		console.log(JSON.stringify({ "perFile": perFile, "surface": surface }, null, 2));
	} else {
		console.log(`consumer surface: ${target}   (${Object.keys(perFile).length} files)\n`);
		const ROOT = process.cwd();
		const rows = Object.entries(surface).map(([spec, use]) => ({ "spec": spec, "use": use, "c": classify(spec, ROOT) }));
		const width = Math.max(10, ...rows.map((r) => (r.c.pkg ?? r.spec).length + (r.c.version?.length ?? 0) + 1));

		for (const group of ["package", "builtin", "local"] as const) {
			const g = rows.filter((r) => r.c.kind === group).sort((a, b) => a.spec.localeCompare(b.spec));

			if (!g.length) { continue; }
			console.log(`  [${group}]`);
			for (const { spec, use, c } of g) {
				const label = c.kind === "package" ? `${c.pkg}@${c.version ?? "?"}` : spec;

				console.log(`    ${label.padEnd(width)}  ${use.members.join(", ") || "—"}${use.dynamic ? "  +dynamic(*)" : ""}`);
			}
		}
	}
}
