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
import { parseSync } from "oxc-parser";
import { readFileSync, statSync, readdirSync } from "node:fs";
import * as path from "node:path";

import { builtinModules } from "node:module";
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => "node:" + m)]);

/** Classify a specifier and, for real deps, resolve the installed version from node_modules. */
export function classify(spec: string, root: string): { kind: "builtin" | "package" | "local"; pkg?: string; version?: string } {
	if (spec.startsWith("node:") || BUILTINS.has(spec)) return { kind: "builtin" };
	if (spec.startsWith(".") || spec.startsWith("/")) return { kind: "local" };
	const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
	try {
		const pj = JSON.parse(readFileSync(path.join(root, "node_modules", pkg, "package.json"), "utf8"));
		return { kind: "package", pkg, version: pj.version };
	} catch { return { kind: "package", pkg }; }
}

interface Binding { specifier: string; kind: "named" | "default" | "namespace"; imported?: string; }
interface Use { members: Set<string>; dynamic: boolean; }
type Surface = Map<string, Use>;   // specifier -> consumed members
export interface SurfaceEntry { members: string[]; dynamic: boolean; }

const isCode = (f: string) => /\.(m|c)?[jt]sx?$/.test(f);

/** Recursively visit every AST node (object with a string `type`). */
function walk(node: any, visit: (n: any) => void) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
	if (typeof node.type === "string") visit(node);
	for (const k in node) { if (k === "type") continue; walk(node[k], visit); }
}

const add = (s: Surface, spec: string, member: string, dynamic = false) => {
	const u = s.get(spec) ?? { members: new Set<string>(), dynamic: false };
	if (member) u.members.add(member);
	if (dynamic) u.dynamic = true;
	s.set(spec, u);
};

export function analyze(file: string): Surface {
	const src = readFileSync(file, "utf8");
	const { program } = parseSync(file, src);
	const surface: Surface = new Map();
	const locals = new Map<string, Binding>();   // local name -> what it binds to

	// 1. collect import bindings
	for (const stmt of program.body as any[]) {
		if (stmt.type !== "ImportDeclaration") continue;
		const spec = stmt.source.value as string;
		if (!stmt.specifiers?.length) { add(surface, spec, ""); continue; }   // side-effect import
		for (const sp of stmt.specifiers) {
			if (sp.type === "ImportSpecifier") {
				const imported = sp.imported.name ?? sp.imported.value;
				locals.set(sp.local.name, { specifier: spec, kind: "named", imported });
				add(surface, spec, imported);                                    // named member is used by definition
			} else if (sp.type === "ImportDefaultSpecifier") {
				locals.set(sp.local.name, { specifier: spec, kind: "default" });
				add(surface, spec, "default");
			} else if (sp.type === "ImportNamespaceSpecifier") {
				locals.set(sp.local.name, { specifier: spec, kind: "namespace" });
				surface.set(spec, surface.get(spec) ?? { members: new Set(), dynamic: false });
			}
		}
	}

	// 2. for namespace bindings, find member access: local.foo  /  local[expr] (→ "*")
	for (const [local, b] of locals) {
		if (b.kind !== "namespace") continue;
		walk(program, (n) => {
			if (n.type === "MemberExpression" && n.object?.type === "Identifier" && n.object.name === local) {
				if (n.computed) add(surface, b.specifier, "", true);             // local[x] → indeterminate
				else if (n.property?.type === "Identifier") add(surface, b.specifier, n.property.name);
			}
		});
	}

	// 3. require("x") / import("x") — record specifier (members indeterminate)
	walk(program, (n) => {
		if (n.type === "CallExpression") {
			const callee = n.callee;
			const isReq = callee?.type === "Identifier" && callee.name === "require";
			const isDyn = callee?.type === "Import";
			if ((isReq || isDyn) && n.arguments?.[0]?.type === "Literal" && typeof n.arguments[0].value === "string") {
				add(surface, n.arguments[0].value, "", true);
			}
		}
	});

	return surface;
}

function files(target: string): string[] {
	const st = statSync(target);
	if (st.isFile()) return [target];
	const out: string[] = [];
	for (const e of readdirSync(target, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const p = path.join(target, e.name);
		if (e.isDirectory()) out.push(...files(p));
		else if (isCode(e.name)) out.push(p);
	}
	return out;
}

/** Merge every code file under `target` into one consumer surface (specifier → members). */
export function projectSurface(target: string): { perFile: Record<string, Record<string, SurfaceEntry>>; surface: Record<string, SurfaceEntry> } {
	const merged: Surface = new Map();
	const perFile: Record<string, Record<string, SurfaceEntry>> = {};
	for (const f of files(path.resolve(target))) {
		const s = analyze(f);
		perFile[path.relative(process.cwd(), f)] = Object.fromEntries([...s].map(([k, v]) => [k, { members: [...v.members].sort(), dynamic: v.dynamic }]));
		for (const [spec, use] of s) { for (const m of use.members) add(merged, spec, m); if (use.dynamic) add(merged, spec, "", true); }
	}
	return { perFile, surface: Object.fromEntries([...merged].map(([k, v]) => [k, { members: [...v.members].sort(), dynamic: v.dynamic }])) };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
	const JSON_MODE = process.argv.includes("--json");
	const target = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? ".";
	const { perFile, surface } = projectSurface(target);
	if (JSON_MODE) {
		console.log(JSON.stringify({ perFile, surface }, null, 2));
	} else {
		console.log(`consumer surface: ${target}   (${Object.keys(perFile).length} files)\n`);
		const ROOT = process.cwd();
		const rows = Object.entries(surface).map(([spec, use]) => ({ spec, use, c: classify(spec, ROOT) }));
		const width = Math.max(10, ...rows.map((r) => (r.c.pkg ?? r.spec).length + (r.c.version?.length ?? 0) + 1));
		for (const group of ["package", "builtin", "local"] as const) {
			const g = rows.filter((r) => r.c.kind === group).sort((a, b) => a.spec.localeCompare(b.spec));
			if (!g.length) continue;
			console.log(`  [${group}]`);
			for (const { spec, use, c } of g) {
				const label = c.kind === "package" ? `${c.pkg}@${c.version ?? "?"}` : spec;
				console.log(`    ${label.padEnd(width)}  ${use.members.join(", ") || "—"}${use.dynamic ? "  +dynamic(*)" : ""}`);
			}
		}
	}
}
