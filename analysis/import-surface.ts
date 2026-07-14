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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";

import { parseSync } from "oxc-parser";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => "node:" + m)]);

/** Classify a specifier and, for real deps, resolve the installed version from node_modules. */
export function classify(spec: string, fromDir: string, stopRoot: string = fromDir): { "kind": "builtin" | "package" | "local"; "pkg"?: string; "version"?: string } {
	if (spec.startsWith("node:") || BUILTINS.has(spec)) { return { "kind": "builtin" }; }
	if (spec.startsWith(".") || spec.startsWith("/")) { return { "kind": "local" }; }
	const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

	// Walk node_modules up from the workspace dir to the project root: a workspace-local version wins,
	// else the hoisted root one — so non-hoisted monorepos resolve the version each package actually has.
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const pj = path.join(d, "node_modules", pkg, "package.json");

		if (existsSync(pj)) { try { return { "kind": "package", "pkg": pkg, "version": JSON.parse(readFileSync(pj, "utf8")).version }; } catch { break; } }
		if (d === stop || d === path.dirname(d)) { break; }
	}

	return { "kind": "package", "pkg": pkg };
}

interface Binding { "specifier": string; "kind": "named" | "default" | "namespace"; "imported"?: string }
interface Use { "members": Set<string>; "dynamic": boolean }
type Surface = Map<string, Use>;   // specifier -> consumed members
export interface SurfaceEntry { "members": string[]; "dynamic": boolean }

const isCode = (f: string) => /\.(m|c)?[jt]sx?$/.test(f);

/** Recursively visit every AST node (object with a string `type`). */
function walk(node: any, visit: (n: any) => void) {
	if (!node || typeof node !== "object") { return; }
	if (Array.isArray(node)) {
		for (const c of node) { walk(c, visit); }

		return;
	}

	if (typeof node.type === "string") { visit(node); }
	for (const k in node) { if (k === "type") { continue; } walk(node[k], visit); }
}

function add(s: Surface, spec: string, member: string, dynamic = false) {
	const u = s.get(spec) ?? { "members": new Set<string>(), "dynamic": false };

	if (member) { u.members.add(member); }
	if (dynamic) { u.dynamic = true; }
	s.set(spec, u);
}

export function analyze(file: string): Surface {
	const src = readFileSync(file, "utf8");
	const { program } = parseSync(file, src);
	const surface: Surface = new Map();
	const locals = new Map<string, Binding>();   // local name -> what it binds to

	// 1. collect import bindings
	for (const stmt of program.body as any[]) {
		if (stmt.type !== "ImportDeclaration") { continue; }
		const spec = stmt.source.value as string;

		if (!stmt.specifiers?.length) { add(surface, spec, ""); continue; }   // side-effect import
		for (const sp of stmt.specifiers) {
			if (sp.type === "ImportSpecifier") {
				const imported = sp.imported.name ?? sp.imported.value;

				locals.set(sp.local.name, { "specifier": spec, "kind": "named", "imported": imported });
				add(surface, spec, imported);                                    // named member is used by definition
			} else if (sp.type === "ImportDefaultSpecifier") {
				locals.set(sp.local.name, { "specifier": spec, "kind": "default" });
				add(surface, spec, "default");
			} else if (sp.type === "ImportNamespaceSpecifier") {
				locals.set(sp.local.name, { "specifier": spec, "kind": "namespace" });
				surface.set(spec, surface.get(spec) ?? { "members": new Set(), "dynamic": false });
			}
		}
	}

	// 2. for namespace bindings, find member access: local.foo  /  local[expr] (→ "*")
	for (const [local, b] of locals) {
		if (b.kind !== "namespace") { continue; }
		walk(program, (n) => {
			if (n.type === "MemberExpression" && n.object?.type === "Identifier" && n.object.name === local) {
				if (n.computed) { add(surface, b.specifier, "", true); }             // local[x] → indeterminate
				else if (n.property?.type === "Identifier") { add(surface, b.specifier, n.property.name); }
			}
		});
	}

	// 3. require("x") / import("x") — record specifier (members indeterminate)
	walk(program, (n) => {
		if (n.type === "CallExpression") {
			const { callee } = n;
			const isReq = callee?.type === "Identifier" && callee.name === "require";
			const isDyn = callee?.type === "Import";

			if ((isReq || isDyn) && n.arguments?.[0]?.type === "Literal" && typeof n.arguments[0].value === "string") {
				add(surface, n.arguments[0].value, "", true);
			}
		}
	});

	return surface;
}

/** A directory that is its own package and is marked `private: true`. Such NESTED workspaces are
 *  silo-ignored everywhere — a private subproject (e.g. a vscode-in-browser playground) carries its own
 *  deps and isn't governed by the enclosing project's baseline. The audit *target* itself is never tested
 *  here (see `files`), so `cd examples/ci-demo && silo audit` still works even when ci-demo is private. */
function isPrivateWorkspace(dir: string): boolean {
	const pj = path.join(dir, "package.json");

	if (!existsSync(pj)) { return false; }
	try { return JSON.parse(readFileSync(pj, "utf8"))["private"] === true; } catch { return false; }
}

function files(target: string): string[] {
	const st = statSync(target);

	if (st.isFile()) { return [target]; }
	const out: string[] = [];

	for (const e of readdirSync(target, { "withFileTypes": true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) { continue; }
		const p = path.join(target, e.name);

		// Descend into subdirectories, but prune a nested private workspace (it self-governs).
		if (e.isDirectory()) { if (!isPrivateWorkspace(p)) { out.push(...files(p)); } } else if (isCode(e.name)) { out.push(p); }
	}

	return out;
}

/** Merge every code file under `target` into one consumer surface (specifier → members). */
export function projectSurface(target: string): { "perFile": Record<string, Record<string, SurfaceEntry>>; "surface": Record<string, SurfaceEntry> } {
	const merged: Surface = new Map();
	const perFile: Record<string, Record<string, SurfaceEntry>> = {};

	for (const f of files(path.resolve(target))) {
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
		if (existsSync(path.join(d, "package.json"))) { return path.relative(rootAbs, d) || "."; }
		if (d === rootAbs || d === path.dirname(d)) { return "."; }
	}
}

/** Like projectSurface, but partitioned by workspace (nearest package.json) — so a monorepo audit can
 *  attribute each dep's usage to the package that imports it, keyed by path relative to `root`. */
export function workspaceSurfaces(target: string, root: string): Record<string, Record<string, SurfaceEntry>> {
	const buckets = new Map<string, Surface>();

	for (const f of files(path.resolve(target))) {
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
export function workspaceImporters(target: string, root: string): Record<string, Record<string, string[]>> {
	const out: Record<string, Record<string, string[]>> = {};

	for (const f of files(path.resolve(target))) {
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
	const { perFile, surface } = projectSurface(target);

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
