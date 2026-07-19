/**
 * The PURE core of silo's CAPABILITY axis (the `exposed` side) — the browser-portable kernel, mirroring
 * commands/review-core.ts (the review axis). oxc + pure string logic ONLY: no fs, git, eslint, rolldown,
 * or node:module, no top-level side effects. It takes SOURCE TEXT in.
 *
 * This runs in BOTH environments:
 *   • the CLI — import-surface.ts / package-capabilities.ts are the NODE orchestration around it (file
 *     walking, node_modules version resolution, dep bundling+DCE);
 *   • a browser capability view (bundlephobia-style) would import this + fetch dep source itself
 *     (esm.sh → webcrack → `detect`), oxc-parser resolving to its wasm `browser` build.
 *
 * Keep this file free of anything that isn't pure over its inputs, or it stops being portable.
 */
import { parseSync } from "oxc-parser";

export { DETECTORS, detect, refine } from "./capability-detectors.js";

// Node's public builtin module names, inlined (node:module's `builtinModules` isn't available in the
// browser). Matched in both bare and `node:`-prefixed forms.
const BUILTIN_NAMES = [
	"assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
	"crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises",
	"http", "http2", "https", "inspector", "inspector/promises", "module", "net", "os", "path", "path/posix",
	"path/win32", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "repl",
	"stream", "stream/consumers", "stream/promises", "stream/web", "string_decoder", "sys", "timers",
	"timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi",
	"worker_threads", "zlib", "sea", "sqlite", "test", "test/reporters"
];
const BUILTINS = new Set(BUILTIN_NAMES.flatMap((m) => { const bare = m.replace(/^node:/u, ""); return [bare, "node:" + bare]; }));

/** Kind + package name for a specifier. Version resolution (node_modules) is Node-only — do it separately. */
export function classifyKind(spec: string): { "kind": "builtin" | "package" | "local"; "pkg"?: string } {
	if (spec.startsWith("node:") || BUILTINS.has(spec)) { return { "kind": "builtin" }; }
	if (spec.startsWith(".") || spec.startsWith("/")) { return { "kind": "local" }; }
	const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

	return { "kind": "package", "pkg": pkg };
}

interface Binding { "specifier": string; "kind": "named" | "default" | "namespace"; "imported"?: string }
export interface Use { "members": Set<string>; "dynamic": boolean }
export type Surface = Map<string, Use>;   // specifier -> consumed members
export interface SurfaceEntry { "members": string[]; "dynamic": boolean }

/** Recursively visit every AST node (object with a string `type`). */
function walk(node: any, visit: (n: any) => void): void {
	if (!node || typeof node !== "object") { return; }
	if (Array.isArray(node)) { for (const c of node) { walk(c, visit); } return; }
	if (typeof node.type === "string") { visit(node); }
	for (const k in node) { if (k === "type") { continue; } walk(node[k], visit); }
}

export function add(s: Surface, spec: string, member: string, dynamic = false): void {
	const u = s.get(spec) ?? { "members": new Set<string>(), "dynamic": false };

	if (member) { u.members.add(member); }
	if (dynamic) { u.dynamic = true; }
	s.set(spec, u);
}

/** The consumer capability surface from SOURCE TEXT: specifier → members used (`*`/dynamic = indeterminate).
 *  Reading the file is the caller's job (fs in Node, workspace.fs / fetch in the browser). */
export function surfaceOfSource(file: string, src: string): Surface {
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
				add(surface, spec, imported);
			} else if (sp.type === "ImportDefaultSpecifier") {
				locals.set(sp.local.name, { "specifier": spec, "kind": "default" });
				add(surface, spec, "default");
			} else if (sp.type === "ImportNamespaceSpecifier") {
				locals.set(sp.local.name, { "specifier": spec, "kind": "namespace" });
				surface.set(spec, surface.get(spec) ?? { "members": new Set(), "dynamic": false });
			}
		}
	}

	// 2. for namespace bindings, find member access: local.foo / local[expr] (→ "*")
	for (const [local, b] of locals) {
		if (b.kind !== "namespace") { continue; }
		walk(program, (n) => {
			if (n.type === "MemberExpression" && n.object?.type === "Identifier" && n.object.name === local) {
				if (n.computed) { add(surface, b.specifier, "", true); } else if (n.property?.type === "Identifier") { add(surface, b.specifier, n.property.name); }
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

/** Builtins ARE capabilities — map (specifier, members) directly, no bundling. */
export function builtinCaps(spec: string, members: string[], dynamic = false): string[] {
	const base = spec.replace(/^node:/u, "");
	const caps = new Set<string>();

	if (base === "fs" || base === "fs/promises") {
		for (const m of members) {
			if (/^(read|exists|stat|realpath|access|opendir|watch|lstat)/u.test(m) || m === "createReadStream") { caps.add("fs:read"); } else if (/^(write|append|mkdir|unlink|rm|rename|cp|copy|chmod|chown|truncate|symlink|link|utimes|open|mkdtemp)/u.test(m) || m === "createWriteStream") { caps.add("fs:write"); } else { caps.add("fs"); }
		}

		if (dynamic || !members.length) { caps.add("fs"); }
		if (caps.has("fs:read") || caps.has("fs:write")) { caps.delete("fs"); }
	} else if (base === "child_process") { caps.add("exec"); } else if (["net", "http", "https", "http2", "tls", "dgram", "dns"].includes(base)) { caps.add("net"); } else if (base === "vm") { caps.add("eval"); }

	return [...caps].sort();
}
