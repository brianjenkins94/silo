/**
 * The `silo <script>` execution path: fingerprint a script, gate imports, box it with the broker, run
 * it, capture the scopes the broker granted, and score confidence from run history. `ls` lists what's
 * been managed; `installCmd` shells the cooldown installer.
 */
import type { ImportPolicy } from "./policy/import-policy.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "@brianjenkins94/util/fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BOX_TS, CAP_ENGINE, ensureSiloDir, LEDGER, PROJECT, REGISTRY, RUNNER, TOOL } from "./paths.js";
import { checkImports, extractImports } from "./policy/import-policy.js";

// Illustrative import denylist — a real deployment supplies its own.
const POLICY: ImportPolicy = {
	"prohibited": {
		"left-pad": { "reason": "banned — use String.prototype.padStart" }
	}
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const uniq = <T>(a: T[]) => [...new Set(a)];

interface Entry { "sha": string; "imports": string[]; "staticCaps": string[]; "approved": string[] }
type Reg = Record<string, Entry>;
const loadReg = (): Reg => (fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY)) : {});

async function saveReg(r: Reg) { await ensureSiloDir(); fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2) + "\n"); }

interface RunRec { "script": string; "ts": string; "sha": string; "exit": number; "mode": string }
const ledger = (): RunRec[] => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Churn-decayed Wilson lower bound: real runs weigh 1.0, dry-runs 0.25; stale-sha runs decay. */
function confidence(script: string, currentSha: string) {
	const runs = ledger().filter((r) => r.script === script);
	let n = 0; let
		s = 0;

	for (const r of runs) {
		const w = (r.mode === "apply" ? 1 : 0.25) * (r.sha === currentSha ? 1 : 0.4);

		n += w; if (r.exit === 0) { s += w; }
	}

	if (n === 0) { return { "band": "unproven", "score": 0, "n": 0 }; }
	const p = s / n; const z = 1.96; const
		lb = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);

	return { "band": lb < 0.2 ? "unproven" : lb < 0.6 ? "provisional" : "trusted", "score": Math.round(lb * 100), "n": runs.length };
}

/** STATIC: run the static-caps-lsp engine (--json) once per content hash. */
function staticCaps(file: string): string[] {
	const r = spawnSync(RUNNER[0], [...RUNNER.slice(1), CAP_ENGINE, file, "--json"], { "encoding": "utf8", "env": { ...process.env, "NODE_OPTIONS": "" } });
	const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";

	try { return JSON.parse(line).caps ?? []; } catch { return []; }
}

/** Bundle the script with the broker + builtin rewriting (instrument.ts). */
function box(file: string): string {
	const out = path.join(tmpdir(), "silo-" + process.pid + "-" + path.basename(file).replace(/\.[^.]+$/u, "") + ".box.mjs");

	spawnSync(RUNNER[0], [...RUNNER.slice(1), BOX_TS, file, out], { "stdio": ["ignore", "ignore", "inherit"], "env": { ...process.env, "NODE_OPTIONS": "" } });

	return out;
}

/** Seed the broker's allowlists from approved scopes (net:host:port → host, fs:op:path → path, exec:bin → bin). */
function seedEnv(approved: string[]) {
	return {
		"ALLOW_NET": uniq(approved.filter((s) => s.startsWith("net:")).map((s) => s.slice(4).split(":")[0])).join(","),
		"ALLOW_FS": uniq(approved.filter((s) => s.startsWith("fs:")).map((s) => s.split(":").slice(2).join(":"))).join(","),
		"ALLOW_EXEC": uniq(approved.filter((s) => s.startsWith("exec:")).map((s) => s.slice(5))).join(",")
	};
}

/** ENFORCE: run the boxed bundle; broker gates on the allowlist + JUDICIAL; capture granted scopes.
 *  Passes SILO_SCRIPT/SILO_CONFIDENCE so a JUDICIAL judge can decide with Silo's own signals. */
async function execBoxed(boxFile: string, args: string[], approved: string[], ctx: { "script": string; "confidence": string }) {
	const grantLog = path.join("/private/tmp", `grants-${process.pid}-${Date.now()}`);
	const res = spawnSync("node", [boxFile, ...args], { "stdio": "inherit", "env": { ...process.env, "NODE_OPTIONS": "", "GRANT_LOG": grantLog, "SILO_SCRIPT": ctx.script, "SILO_CONFIDENCE": ctx.confidence, ...seedEnv(approved) } });
	const grants = fs.existsSync(grantLog) ? uniq(fs.readFileSync(grantLog).trim().split("\n").filter(Boolean)) : [];

	await fs.rm(grantLog, { "force": true });

	return { "exit": res.status ?? 1, "grants": grants };
}

export function ls(): void {
	const reg = loadReg();

	for (const [script, e] of Object.entries(reg)) {
		const c = confidence(script, e.sha);
		const runs = ledger().filter((r) => r.script === script); const
			ok = runs.filter((r) => r.exit === 0).length;

		console.log(`  ${script.padEnd(20)}  static: ${e.staticCaps.join(",") || "—"}   approved: ${e.approved.length}   ${ok}✓/${runs.length - ok}✗   ${c.band} ${c.score}%`);
	}

	if (!Object.keys(reg).length) { console.log("  (no managed scripts yet)"); }
}

export async function run(scriptArg: string, args: string[]): Promise<void> {
	const file = path.resolve(scriptArg); const rel = path.relative(PROJECT, file); const src = fs.readFileSync(file); const
		h = sha(src);
	const imports = extractImports(src); const
		violations = checkImports(imports, POLICY);
	const reg = loadReg(); const
		prev = reg[rel];

	const caps = prev?.sha === h && prev.staticCaps ? prev.staticCaps : staticCaps(file);   // cached per content hash

	console.log(`▶ ${rel}`);
	console.log(`  static caps: ${caps.join(", ") || "— none —"}${prev?.sha === h ? "  (cached)" : ""}`);
	if (violations.length) {
		console.log("  ⚠ import-policy:");
		for (const v of violations) { console.log(`     ✗ ${v.specifier}${v.use ? ` → use ${v.use}` : ""}${v.reason ? ` (${v.reason})` : ""}`); }
	}

	if (!prev) { console.log("  ↑ new script — approving fingerprint (TOFU)"); } else {
		const nc = caps.filter((c) => !prev.staticCaps.includes(c)); const
			ni = imports.filter((i) => !prev.imports.includes(i));

		if (nc.length || ni.length) { console.log(`  ↑ drift — new caps:[${nc.join(",") || "—"}] new imports:[${ni.join(",") || "—"}] (would prompt)`); } else if (prev.sha !== h) { console.log("  ~ edited (same caps) — confidence decays"); }
	}

	console.log(`  confidence: ${(() => {
		const c = confidence(rel, h);

		return `${c.band} ${c.score}% / ${c.n} runs`;
	})()}`);

	const approved = prev?.approved ?? [];

	console.log(`  approved scopes: ${approved.length}   (allowlist seeds the broker; new scopes prompt)`);
	const mode = args.includes("--apply") ? "apply" : "dry-run";

	console.log(`  → boxing + executing (${mode}) …\n`);
	const { exit, grants } = await execBoxed(box(file), args, approved, { "script": rel, "confidence": confidence(rel, h).band });

	const newGrants = grants.filter((g) => !approved.includes(g));

	reg[rel] = { "sha": h, "imports": imports, "staticCaps": caps, "approved": uniq([...approved, ...grants]) };
	await saveReg(reg);
	await fs.appendFile(LEDGER, JSON.stringify({ "script": rel, "ts": new Date().toISOString(), "sha": h, "exit": exit, "mode": mode } satisfies RunRec) + "\n");

	console.log(`\n  exit ${exit}`);
	if (newGrants.length) { console.log(`  newly granted (persisted): ${newGrants.join(", ")}`); }
	const after = confidence(rel, h);

	console.log(`  confidence → ${after.band} ${after.score}% / ${after.n} runs`);
}

/** Cooldown-aware install — delegates to policy/cooldown.mjs (the same engine the `preinstall` hook runs,
 *  so `silo install` and a bare `npm install` behave identically). An explicit entry for passing args. */
export function installCmd(args: string[]): void {
	const r = spawnSync(process.execPath, [path.join(TOOL, "policy/cooldown.mjs"), ...args], { "stdio": "inherit" });

	process.exit(r.status ?? 0);
}
