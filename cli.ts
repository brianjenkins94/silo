/**
 * PROTOTYPE — `run`: the consolidated gate-and-delegate script runner.
 *
 *   tsx cli.ts <script> [args…]   static engine + import policy → drift gate → box + execute
 *                                         under the broker → merge granted scopes → score
 *   tsx cli.ts ls                 list managed scripts with caps + approved scopes + confidence
 *
 * Two capability layers, merged into one fingerprint:
 *   • STATIC  — static-caps-lsp's call-hierarchy engine: coarse capability *classes* reachable per export
 *               (fs, exec, net). Complete-ish (all paths), no execution.
 *   • RUNTIME — the bundle-injected broker intercepts calls and gates the *resolved scopes* actually
 *               exercised (net:localhost:3000). Precise, partial (only paths that ran), per run.
 * Static says what it CAN do; runtime refines to where it DID — and a newly-observed scope outside
 * what's been approved is the flag.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { extractImports, checkImports, type ImportPolicy } from "./runner/import-policy.js";
import { projectSurface, classify, type SurfaceEntry } from "./audit/import-surface.js";
import { capsOf, builtinCaps } from "./audit/package-capabilities.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const REGISTRY = path.join(ROOT, "registry.json");
const DEPS = path.join(ROOT, "deps.json");
const LEDGER = path.join(ROOT, "runs.jsonl");
const TSX_BIN = path.join(ROOT, "node_modules/.bin/tsx");
const CAP_ENGINE = path.join(ROOT, "runner/static-caps-lsp.ts");
const BOX_TS = path.join(ROOT, "runner/instrument.ts");

// Illustrative import denylist — a real deployment supplies its own.
const POLICY: ImportPolicy = {
	prohibited: {
		"left-pad": { reason: "banned — use String.prototype.padStart" },
	},
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const uniq = <T,>(a: T[]) => [...new Set(a)];

type Entry = { sha: string; imports: string[]; staticCaps: string[]; approved: string[] };
type Reg = Record<string, Entry>;
const loadReg = (): Reg => existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {};
const saveReg = (r: Reg) => writeFileSync(REGISTRY, JSON.stringify(r, null, 2) + "\n");

interface RunRec { script: string; ts: string; sha: string; exit: number; mode: string; }
const ledger = (): RunRec[] => existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** Churn-decayed Wilson lower bound: real runs weigh 1.0, dry-runs 0.25; stale-sha runs decay. */
function confidence(script: string, currentSha: string) {
	const runs = ledger().filter((r) => r.script === script);
	let s = 0, n = 0;
	for (const r of runs) { const w = (r.mode === "apply" ? 1 : 0.25) * (r.sha === currentSha ? 1 : 0.4); n += w; if (r.exit === 0) s += w; }
	if (n === 0) return { band: "unproven", score: 0, n: 0 };
	const p = s / n, z = 1.96, lb = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
	return { band: lb < 0.2 ? "unproven" : lb < 0.6 ? "provisional" : "trusted", score: Math.round(lb * 100), n: runs.length };
}

/** STATIC: run the static-caps-lsp engine (--json) once per content hash. */
function staticCaps(file: string): string[] {
	const r = spawnSync(TSX_BIN, [CAP_ENGINE, file, "--json"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
	const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
	try { return JSON.parse(line).caps ?? []; } catch { return []; }
}

/** Bundle the script with the broker + builtin rewriting (instrument.ts). */
function box(file: string): string {
	const out = path.join(ROOT, "." + path.basename(file).replace(/\.[^.]+$/u, "") + ".box.mjs");
	spawnSync(TSX_BIN, [BOX_TS, file, out], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, NODE_OPTIONS: "" } });
	return out;
}

/** Seed the broker's allowlists from approved scopes (net:host:port → host, fs:op:path → path, exec:bin → bin). */
const seedEnv = (approved: string[]) => ({
	ALLOW_NET: uniq(approved.filter((s) => s.startsWith("net:")).map((s) => s.slice(4).split(":")[0])).join(","),
	ALLOW_FS: uniq(approved.filter((s) => s.startsWith("fs:")).map((s) => s.split(":").slice(2).join(":"))).join(","),
	ALLOW_EXEC: uniq(approved.filter((s) => s.startsWith("exec:")).map((s) => s.slice(5))).join(","),
});

/** ENFORCE: run the boxed bundle; broker gates on the allowlist and prompts; capture granted scopes. */
function execBoxed(boxFile: string, args: string[], approved: string[]) {
	const grantLog = path.join("/private/tmp", `grants-${process.pid}-${Date.now()}`);
	const res = spawnSync("node", [boxFile, ...args], { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "", GRANT_LOG: grantLog, ...seedEnv(approved) } });
	const grants = existsSync(grantLog) ? uniq(readFileSync(grantLog, "utf8").trim().split("\n").filter(Boolean)) : [];
	rmSync(grantLog, { force: true });
	return { exit: res.status ?? 1, grants };
}

function ls() {
	const reg = loadReg();
	for (const [script, e] of Object.entries(reg)) {
		const c = confidence(script, e.sha);
		const runs = ledger().filter((r) => r.script === script), ok = runs.filter((r) => r.exit === 0).length;
		console.log(`  ${script.padEnd(20)}  static: ${e.staticCaps.join(",") || "—"}   approved: ${e.approved.length}   ${ok}✓/${runs.length - ok}✗   ${c.band} ${c.score}%`);
	}
	if (!Object.keys(reg).length) console.log("  (no managed scripts yet)");
}

function run(scriptArg: string, args: string[]) {
	const file = path.resolve(scriptArg), rel = path.relative(ROOT, file), src = readFileSync(file, "utf8"), h = sha(src);
	const imports = extractImports(src), violations = checkImports(imports, POLICY);
	const reg = loadReg(), prev = reg[rel];

	const caps = prev?.sha === h && prev.staticCaps ? prev.staticCaps : staticCaps(file);   // cached per content hash

	console.log(`▶ ${rel}`);
	console.log(`  static caps: ${caps.join(", ") || "— none —"}${prev?.sha === h ? "  (cached)" : ""}`);
	if (violations.length) {
		console.log("  ⚠ import-policy:");
		for (const v of violations) console.log(`     ✗ ${v.specifier}${v.use ? ` → use ${v.use}` : ""}${v.reason ? ` (${v.reason})` : ""}`);
	}
	if (!prev) console.log("  ↑ new script — approving fingerprint (TOFU)");
	else {
		const nc = caps.filter((c) => !prev.staticCaps.includes(c)), ni = imports.filter((i) => !prev.imports.includes(i));
		if (nc.length || ni.length) console.log(`  ↑ drift — new caps:[${nc.join(",") || "—"}] new imports:[${ni.join(",") || "—"}] (would prompt)`);
		else if (prev.sha !== h) console.log("  ~ edited (same caps) — confidence decays");
	}
	console.log(`  confidence: ${(() => { const c = confidence(rel, h); return `${c.band} ${c.score}% / ${c.n} runs`; })()}`);

	const approved = prev?.approved ?? [];
	console.log(`  approved scopes: ${approved.length}   (allowlist seeds the broker; new scopes prompt)`);
	const mode = args.includes("--apply") ? "apply" : "dry-run";
	console.log(`  → boxing + executing (${mode}) …\n`);
	const { exit, grants } = execBoxed(box(file), args, approved);

	const newGrants = grants.filter((g) => !approved.includes(g));
	reg[rel] = { sha: h, imports, staticCaps: caps, approved: uniq([...approved, ...grants]) };
	saveReg(reg);
	appendFileSync(LEDGER, JSON.stringify({ script: rel, ts: new Date().toISOString(), sha: h, exit, mode } satisfies RunRec) + "\n");

	console.log(`\n  exit ${exit}`);
	if (newGrants.length) console.log(`  newly granted (persisted): ${newGrants.join(", ")}`);
	const after = confidence(rel, h);
	console.log(`  confidence → ${after.band} ${after.score}% / ${after.n} runs`);
}

// ── CONSUMER audit: member-level dependency surface → capability + TOFU drift gate ──
type DepEntry = { kind: string; version?: string; members: string[]; dynamic: boolean; caps: string[] };
type Deps = Record<string, DepEntry>;
const loadDeps = (): Deps => existsSync(DEPS) ? JSON.parse(readFileSync(DEPS, "utf8")) : {};
const saveDeps = (d: Deps) => writeFileSync(DEPS, JSON.stringify(d, null, 2) + "\n");

/** `silo audit [dir] [--approve]` — surface → capability per dep, diffed vs baseline; gates new members/caps. */
async function audit(args: string[]) {
	const approve = args.includes("--approve");
	const target = args.find((a) => !a.startsWith("--")) ?? ".";
	const { surface } = projectSurface(path.resolve(target));
	const prev = loadDeps();
	const next: Deps = {};
	let drift = 0;

	// track real deps (packages) + builtins; local relative imports are the user's own code, not a dep
	const tracked = Object.entries(surface)
		.map(([spec, use]) => ({ spec, use, c: classify(spec, ROOT) }))
		.filter((r) => r.c.kind !== "local")
		.sort((a, b) => a.spec.localeCompare(b.spec));

	console.log(`▶ audit ${target}   (${tracked.length} dependencies)\n`);
	const width = Math.max(10, ...tracked.map((r) => (r.c.pkg ?? r.spec).length + (r.c.version?.length ?? 0) + 1));
	for (const { spec, use, c } of tracked) {
		const label = c.kind === "package" ? `${c.pkg}@${c.version ?? "?"}` : spec;
		const caps = c.kind === "builtin" ? builtinCaps(spec, use.members, use.dynamic) : await capsOf(c.pkg!, [...use.members, ...(use.dynamic ? ["*"] : [])], ROOT);
		next[spec] = { kind: c.kind, version: c.version, members: use.members, dynamic: use.dynamic, caps };
		const capStr = caps.join(", ") || "— pure —";

		const p = prev[spec];
		let mark = "";
		if (!p) { mark = "+ new"; drift++; }
		else {
			const gMembers = use.members.filter((m) => !p.members.includes(m));
			const gCaps = caps.filter((c) => !(p.caps ?? []).includes(c));
			const newDyn = use.dynamic && !p.dynamic;
			if (gCaps.length || gMembers.length || newDyn) {
				mark = "↑ " + [gCaps.length ? `+cap ${gCaps.join(",")}` : "", gMembers.length ? `+${gMembers.join(",")}` : "", newDyn ? "+dynamic(*)" : ""].filter(Boolean).join(" ");
				drift++;
			} else if (c.version && p.version && c.version !== p.version) mark = `~ ${p.version}→${c.version}`;
		}
		console.log(`  ${label.padEnd(width)}  ${use.members.join(", ") || "—"}${use.dynamic ? " *" : ""}  →  ${capStr}${mark ? `   ${mark}` : ""}`);
	}
	for (const s of Object.keys(prev).filter((s) => !(s in next))) console.log(`  − removed    ${s}`);

	if (!Object.keys(prev).length) { saveDeps(next); console.log(`\n  TOFU — baseline recorded (${tracked.length} deps). Re-run to gate drift.`); return; }
	if (approve) { saveDeps(next); console.log(`\n  ✓ approved — baseline updated`); return; }
	if (drift) { console.log(`\n  ⚠ ${drift} un-approved change(s). Review, then \`silo audit --approve\`.`); process.exit(1); }
	console.log("\n  ✓ no drift");
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "ls") ls();
else if (cmd === "audit") await audit(rest);
else run(cmd, rest);
