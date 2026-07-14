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
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
import { rolldown } from "rolldown";
import { detect, refine } from "../vocabulary/capability-detectors.js";
import { deobfuscate, isLikelyBundled, resolveEntry } from "./deobfuscate.js";

export { detect } from "../vocabulary/capability-detectors.js";

/** The specifier(s) to probe for a WHOLE-package fingerprint.
 *
 *  A subpath-only package (no `.` export — e.g. @brianjenkins94/util) CANNOT be imported by its bare name:
 *  `import * as M from "@brianjenkins94/util"` doesn't resolve, rolldown throws, and capsOf swallows it as
 *  `["?"]` — an analyzer failure masquerading as "unanalyzable code". Expand to the package's concrete
 *  subpath exports instead, so the fingerprint is the union over every entry point it actually offers. */
function entrySpecifiers(spec: string, fromDir: string, stopRoot: string): string[] {
	const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

	if (spec !== pkg) { return [spec]; }   // already a subpath — probe it as written

	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const pj = path.join(d, "node_modules", pkg, "package.json");

		if (fs.existsSync(pj)) {
			try {
				const exp = JSON.parse(fs.readFileSync(pj)).exports;

				if (exp === undefined || typeof exp === "string" || "." in exp) { return [pkg]; }   // legacy main, or a real root export

				const subs = Object.keys(exp).filter((k) => k.startsWith("./") && !k.includes("*")).map((k) => pkg + k.slice(1));

				return subs.length ? subs : [pkg];
			} catch { return [pkg]; }
		}

		if (d === stop || d === path.dirname(d)) { break; }
	}

	return [pkg];
}

/** Remove any probe entries a previously-killed run leaked. Cheap: one readdir of the root. */
async function sweepProbeEntries(root: string): Promise<void> {
	try {
		for (const f of await fs.readdir(root)) { if (/^\.cap-\d+-\w+\.mjs$/u.test(f)) { await fs.rm(path.join(root, f), { "force": true }); } }
	} catch { /* root unreadable — nothing to sweep */ }
}

/** rolldown-DCE the installed package rooted at `members` (slice-precise; under-reports through thunks).
 *  The probe is written in `fromDir`, so rolldown resolves the package from that workspace's node_modules
 *  first (walking up to the hoisted root) — matching how the package is actually installed. */
async function probe(imports: string, refs: string, root: string): Promise<string[] | undefined> {
	// The probe entry MUST live in the project tree: rolldown resolves the package by walking node_modules up
	// from the entry's own location, so a tmpdir entry can't find the dep (→ false `?`). `finally` removes it
	// on the normal path; `sweepProbeEntries` mops up any left by a killed process, and it's gitignored so a
	// leak can never be committed. `.cap-<pid>-` prefix keeps concurrent runs from deleting each other's files.
	const tmpEntry = path.join(root, `.cap-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);

	fs.writeFileSync(tmpEntry, `${imports}\nif (globalThis.__never) console.log(${refs || "0"});\n`);
	try {
		const b = await rolldown({ "input": tmpEntry, "external": (id: string) => id.startsWith("node:"), "treeshake": { "moduleSideEffects": false }, "logLevel": "silent" });
		const { output } = await b.generate({ "format": "es" });

		await b.close();

		return detect(output.map((o: any) => o.code ?? "").join("\n"));
	} catch {
		return undefined;   // this probe didn't resolve/bundle
	} finally {
		await fs.rm(tmpEntry, { "force": true });
	}
}

async function dceCaps(pkg: string, members: string[], fromDir: string, stopRoot: string): Promise<string[]> {
	const root = fromDir;
	const named = members.filter((m) => m !== "default" && m !== "*");
	const wantAll = !members.length || members.includes("*");   // dynamic/indeterminate → whole package
	const wantDefault = members.includes("default");

	if (wantAll) {
		const specs = entrySpecifiers(pkg, fromDir, stopRoot);
		// Fast path: one probe over every entry point. If it bundles, that's the whole fingerprint.
		const together = await probe(specs.map((s, i) => `import * as M${i} from ${JSON.stringify(s)};`).join("\n"), specs.map((_, i) => `M${i}`).join(", "), root);

		if (together) { return together; }

		// Fan out. All-or-nothing was WRONG: a package with many entry points (util has 46) fails as a whole
		// if ONE is unresolvable — typically an optional peer that isn't installed (playwright, googleapis) —
		// and the entire fingerprint collapses to `?`. Probe each entry alone and union what resolves:
		// partial knowledge beats none, and over-approximating from what we CAN see is the safe bias.
		const all = new Set<string>();
		let any = false;

		for (const s of specs) {
			const caps = await probe(`import * as M from ${JSON.stringify(s)};`, "M", root);

			if (caps) { any = true; caps.forEach((c) => all.add(c)); }
		}

		return any ? [...all].sort() : ["?"];   // every entry failed → genuinely unanalyzable
	}

	const refs = [wantDefault ? "D" : "", named.length ? `{ ${named.join(", ")} }` : ""].filter(Boolean).join(", ");
	const imports = [wantDefault ? `import D from ${JSON.stringify(pkg)};` : "", named.length ? `import { ${named.join(", ")} } from ${JSON.stringify(pkg)};` : ""].filter(Boolean).join("\n");

	return (await probe(imports, refs, root)) ?? ["?"];
}

/** Capability of the package slice. Bundled dist → DCE ∪ deobfuscation (so a deob failure never loses caps). */
export async function capsOf(pkg: string, members: string[], fromDir: string, stopRoot: string = fromDir): Promise<string[]> {
	await sweepProbeEntries(fromDir);
	const entry = await resolveEntry(pkg, fromDir, stopRoot);
	const dce = await dceCaps(pkg, members, fromDir, stopRoot);

	if (!(entry && isLikelyBundled(fs.readFileSync(entry)))) { return dce; }
	// bundled artifact: union DCE with both deobfuscators' detection (whole-bundle over-approx — safe bias).
	const all = new Set(dce);

	for (const v of await deobfuscate(entry, fromDir)) { detect(v).forEach((c) => all.add(c)); }
	const out = refine(all);

	return out.length ? out : ["?"];
}

/** Find an installed package's directory, walking node_modules up from `fromDir` to `stopRoot`. */
function packageDir(pkg: string, fromDir: string, stopRoot: string): string | undefined {
	for (let d = path.resolve(fromDir), stop = path.resolve(stopRoot); ; d = path.dirname(d)) {
		const dir = path.join(d, "node_modules", pkg);

		if (fs.existsSync(path.join(dir, "package.json"))) { return dir; }
		if (d === stop || d === path.dirname(d)) { return undefined; }
	}
}

/** The only code that runs WITHOUT being imported: npm's install hooks. A hook is a shell command, so its
 *  mere existence IS `exec` at install time — the classic supply-chain vector, and it lives in package.json,
 *  not in the file tree. (`bin` is deliberately excluded: a bin only runs if you invoke it.) */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

function installHookCaps(dir: string): string[] {
	try {
		const scripts = JSON.parse(fs.readFileSync(path.join(dir, "package.json"))).scripts ?? {};
		const hooks = INSTALL_HOOKS.filter((h) => typeof scripts[h] === "string");

		if (!hooks.length) { return []; }

		// The hook runs a shell command → exec, plus whatever the command's text itself reveals.
		return [...new Set(["exec", ...hooks.flatMap((h) => detect(scripts[h]))])];
	} catch {
		return [];
	}
}

/**
 * WHOLE-PACKAGE fingerprint — "what could this package do at all", for supply-chain drift.
 *
 * TREESHAKE, don't scan. A file scan (every shipped .js) sounds safer but is mostly NOISE: packages ship
 * build scripts, tests and benches that can never execute when you import them. Scanning made oxc-parser —
 * a parser, with no bin and no install hook — report `exec, eval, fs:write`, purely from its own
 * `scripts/patch.js` and `build-browser-bundle.js`. With 8 of 13 deps flagged dangerous, the signal dies.
 *
 * So: DCE from the package's real entry points (what can execute if you import it), which is exactly what
 * rolldown is for — PLUS the one thing reachability can't see, and which a file scan doesn't actually catch
 * either: npm's INSTALL HOOKS. Those are the "runs without being imported" vector, and they live in
 * package.json, not in the file tree. That was the real gap; the scan was answering it in the wrong place.
 *
 * Uninstalled optional peers are correctly EXCLUDED: code that isn't on disk cannot execute.
 */
export async function wholePackageCaps(pkg: string, fromDir: string, stopRoot: string = fromDir): Promise<string[]> {
	const dir = packageDir(pkg, fromDir, stopRoot);

	if (!dir) { return []; }   // not installed → cannot run

	const caps = new Set<string>([
		...await capsOf(pkg, [], fromDir, stopRoot),   // import-time: DCE over its real entry points
		...installHookCaps(dir)                        // install-time: the hooks, from package.json
	]);

	caps.delete("?");

	return refine(caps);   // empty = pure; callers render it that way
}

/** Builtins ARE capabilities — map (specifier, members) directly, no bundling. */
export function builtinCaps(spec: string, members: string[], dynamic = false): string[] {
	const base = spec.replace(/^node:/, "");
	const caps = new Set<string>();

	if (base === "fs" || base === "fs/promises") {
		for (const m of members) {
			if (/^(read|exists|stat|realpath|access|opendir|readdir|watch|lstat)/.test(m) || m === "createReadStream") { caps.add("fs:read"); } else if (/^(write|append|mkdir|unlink|rm|rename|cp|copy|chmod|chown|truncate|symlink|link|utimes|open|mkdtemp)/.test(m) || m === "createWriteStream") { caps.add("fs:write"); } else { caps.add("fs"); }
		}

		if (dynamic || !members.length) { caps.add("fs"); }
		if (caps.has("fs:read") || caps.has("fs:write")) { caps.delete("fs"); }
	} else if (base === "child_process") { caps.add("exec"); } else if (["net", "http", "https", "http2", "tls", "dgram", "dns"].includes(base)) { caps.add("net"); } else if (base === "vm") { caps.add("eval"); }

	return [...caps].sort();
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const pkg = args[0] ?? ".";
	const members = (args[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const caps = await capsOf(pkg, members, process.cwd());

	if (process.argv.includes("--json")) { console.log(JSON.stringify({ "pkg": pkg, "slice": members.length ? members : "*", "caps": caps })); } else { console.log(`${pkg}  [${members.join(", ") || "*"}]  →  ${caps.join(", ") || "none"}`); }
}
