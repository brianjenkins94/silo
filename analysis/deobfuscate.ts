/**
 * PROTOTYPE — `deob`: recover analyzable code from a package that ships BUNDLED/minified dist.
 *
 * Many packages publish a pre-bundled `dist/` as the artifact you install — esbuild's `__commonJS`
 * lazy thunks (and minification) defeat static reachability, so package-capabilities' DCE silently DROPS caps
 * (e.g. esbuild's own `exec`). This stage un-thunks the ACTUAL shipped bundle so detection works.
 *
 * Two engines, UNION the result — they fail on orthogonal axes (validated):
 *   • webcrack          — de-obfuscation depth (string-arrays, control-flow, esbuild thunks). Malware case.
 *   • wakaru --unpack=strict — module-format breadth (SystemJS/AMD/UMD/Bun). Exotic-build case.
 * Source = the installed package (local-first). Sourcemaps are NOT used (forgeable; analyze what runs).
 */
import { webcrack } from "webcrack";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const WAKARU = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../node_modules/@wakaru/cli/bin/wakaru");

/** Heuristic: does this look like a bundler artifact rather than authored source? */
export function isLikelyBundled(code: string): boolean {
	if (/__commonJS|__toESM|__require\b|__webpack_require__|System\.register\(|\bdefine\(\[/.test(code)) return true;
	const nl = (code.match(/\n/g) || []).length;
	return code.length > 2000 && code.length / (nl + 1) > 200;   // long average line = minified
}

/** Resolve a package's primary entry file, walking node_modules up from `fromDir` to `stopRoot`
 *  (workspace-local install wins over the hoisted root one). */
export function resolveEntry(pkg: string, fromDir: string, stopRoot: string = fromDir): string | null {
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const dir = path.join(d, "node_modules", pkg);
		try {
			const pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
			const exp = pj.exports?.["."] ?? pj.exports;
			const ent = pj.module ?? (typeof exp === "object" ? exp.import ?? exp.default ?? exp.node : exp) ?? pj.main ?? "index.js";
			const f = path.join(dir, typeof ent === "string" ? ent : "index.js");
			if (statSync(f).isFile()) return f;
		} catch { /* not here — keep walking up */ }
		if (d === stop || d === path.dirname(d)) return null;
	}
}

const readAll = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((e) => {
	const p = path.join(dir, e.name);
	return e.isDirectory() ? readAll(p) : e.name.endsWith(".js") ? readFileSync(p, "utf8") : "";
}).join("\n");

/** Deobfuscate `entry` with both engines; return the recovered-code variants (caller detects + unions). */
export async function deobfuscate(entry: string, _root: string): Promise<string[]> {
	const code = readFileSync(entry, "utf8");
	const out: string[] = [];
	try { out.push((await webcrack(code)).code); } catch {}                       // webcrack: single un-thunked file
	const tmp = mkdtempSync(path.join(tmpdir(), "deob-wk-"));
	try {
		const r = spawnSync("node", [WAKARU, entry, "--unpack=strict", "-o", tmp], { encoding: "utf8" });
		if (!r.status) out.push(readAll(tmp));                                     // wakaru: structural unpack
	} catch {} finally { rmSync(tmp, { recursive: true, force: true }); }
	return out.filter(Boolean);
}
