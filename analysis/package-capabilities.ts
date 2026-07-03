/**
 * PROTOTYPE — `package-capabilities`: capability of the SLICE of a package you actually use.
 *
 *   tsx analysis/package-capabilities.ts <pkg> [member,member…] [--json]
 *
 * Bundles the INSTALLED package (externalizing only node: builtins) with rolldown, rooted at the
 * given named exports — so detected caps are "what the parts of the package I import can reach",
 * transitively. Empty/`*` members → whole package (over-approximation). This is Axis B (capability)
 * to surface.ts's Axis A (interface); `silo audit` joins them.
 *
 * Local-first: analyzes node_modules. (esm.sh is a fallback compute lever for the browser/no-bundler
 * case — deliberately omitted here.) Bundling can fail on exotic packages → returns ["?"] = unanalyzable.
 */
import { rolldown } from "rolldown";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { isLikelyBundled, resolveEntry, deobfuscate } from "./deobfuscate.js";
import { detect, refine } from "../vocabulary/capability-detectors.js";
export { detect } from "../vocabulary/capability-detectors.js";

/** rolldown-DCE the installed package rooted at `members` (slice-precise; under-reports through thunks).
 *  The probe is written in `fromDir`, so rolldown resolves the package from that workspace's node_modules
 *  first (walking up to the hoisted root) — matching how the package is actually installed. */
async function dceCaps(pkg: string, members: string[], fromDir: string): Promise<string[]> {
	const root = fromDir;
	const named = members.filter((m) => m !== "default" && m !== "*");
	const wantAll = !members.length || members.includes("*");   // dynamic/indeterminate → whole package
	const wantDefault = members.includes("default");
	const refs = wantAll ? "M" : [wantDefault ? "D" : "", named.length ? `{ ${named.join(", ")} }` : ""].filter(Boolean).join(", ");
	const imports = wantAll
		? `import * as M from ${JSON.stringify(pkg)};`
		: [wantDefault ? `import D from ${JSON.stringify(pkg)};` : "", named.length ? `import { ${named.join(", ")} } from ${JSON.stringify(pkg)};` : ""].filter(Boolean).join("\n");
	const tmpEntry = path.join(root, `.cap-pkg-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(tmpEntry, `${imports}\nif (globalThis.__never) console.log(${refs || "0"});\n`);
	try {
		const b = await rolldown({ input: tmpEntry, external: (id: string) => id.startsWith("node:"), treeshake: { moduleSideEffects: false }, logLevel: "silent" });
		const { output } = await b.generate({ format: "es" });
		await b.close();
		return detect(output.map((o: any) => o.code ?? "").join("\n"));
	} catch {
		return ["?"];   // unanalyzable (exotic bundle/native/conditional-exports)
	} finally {
		rmSync(tmpEntry, { force: true });
	}
}

/** Capability of the package slice. Bundled dist → DCE ∪ deobfuscation (so a deob failure never loses caps). */
export async function capsOf(pkg: string, members: string[], fromDir: string, stopRoot: string = fromDir): Promise<string[]> {
	const entry = resolveEntry(pkg, fromDir, stopRoot);
	const dce = await dceCaps(pkg, members, fromDir);
	if (!(entry && isLikelyBundled(readFileSync(entry, "utf8")))) return dce;
	// bundled artifact: union DCE with both deobfuscators' detection (whole-bundle over-approx — safe bias).
	const all = new Set(dce);
	for (const v of await deobfuscate(entry, fromDir)) detect(v).forEach((c) => all.add(c));
	const out = refine(all);
	return out.length ? out : ["?"];
}

/** Builtins ARE capabilities — map (specifier, members) directly, no bundling. */
export function builtinCaps(spec: string, members: string[], dynamic = false): string[] {
	const base = spec.replace(/^node:/, "");
	const caps = new Set<string>();
	if (base === "fs" || base === "fs/promises") {
		for (const m of members) {
			if (/^(read|exists|stat|realpath|access|opendir|readdir|watch|lstat)/.test(m) || m === "createReadStream") caps.add("fs:read");
			else if (/^(write|append|mkdir|unlink|rm|rename|cp|copy|chmod|chown|truncate|symlink|link|utimes|open|mkdtemp)/.test(m) || m === "createWriteStream") caps.add("fs:write");
			else caps.add("fs");
		}
		if (dynamic || !members.length) caps.add("fs");
		if (caps.has("fs:read") || caps.has("fs:write")) caps.delete("fs");
	} else if (base === "child_process") caps.add("exec");
	else if (["net", "http", "https", "http2", "tls", "dgram", "dns"].includes(base)) caps.add("net");
	else if (base === "vm") caps.add("eval");
	return [...caps].sort();
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const pkg = args[0] ?? ".";
	const members = (args[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const caps = await capsOf(pkg, members, process.cwd());
	if (process.argv.includes("--json")) console.log(JSON.stringify({ pkg, slice: members.length ? members : "*", caps }));
	else console.log(`${pkg}  [${members.join(", ") || "*"}]  →  ${caps.join(", ") || "— pure —"}`);
}
