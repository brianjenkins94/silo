/**
 * Release-age cooldown installer — the repo's `preinstall` hook AND the engine behind `silo install`.
 *
 * Policy: float to the newest release, but never one published within the last N days (default 7), so a
 * freshly-compromised version can't land during its highest-risk window. With deps pinned to "latest"
 * and no committed lockfile, install then always resolves to newest-that's-≥N-days-old.
 *
 * pnpm has this natively (`minimumReleaseAge`, in minutes) — no workaround needed, so it's tried first
 * (mirrors lib/util/scripts/postinstall.ts). npm only has `--before=<date>`, and npm fixes versions at
 * *resolution* time from startup config, so a lifecycle script can't alter the parent's resolution: the
 * npm fallback RE-RUNS the install itself with `--before=<now − N days>`, guarded against recursion. The
 * parent install then honors the cooled lockfile this wrote and exits 0 — no wrapper, no abort.
 *
 * Pure Node, zero deps on purpose: `preinstall` runs BEFORE node_modules exists, so tsx / silo's own
 * packages aren't available yet — which is also why the preinstall can't just be `silo install`.
 *
 * Run directly too:  node install/cooldown.mjs [--cooldown <days>] [install-args…]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// When we spawn pnpm/npm install below, it re-fires this same hook — the guard makes the inner run a
// no-op so the parent proceeds with our cooled resolution instead of recursing forever.
if (process.env.SILO_COOLDOWN_GUARD) { process.exit(0); }

let days = Number(process.env.SILO_COOLDOWN_DAYS) || 7;
const pass = [];
const argv = process.argv.slice(2);

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--cooldown") { days = Number(argv[++i]); } else if (argv[i].startsWith("--cooldown=")) { days = Number(argv[i].slice("--cooldown=".length)); } else { pass.push(argv[i]); }
}

if (!Number.isFinite(days) || days < 0) { days = 7; }

const minutes = String(days * 24 * 60);
const before = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
const guardEnv = { ...process.env, "SILO_COOLDOWN_GUARD": "1" };

// FAMILY-C BREADCRUMB — when a cooldown install actually changes the lockfile, drop a
// `.silo/pending-review.json` so the next `silo <script>` / audit knows deps moved and can escalate a
// re-review (paths.ts PENDING_REVIEW is the read side). Only ever WRITES into an existing `.silo/` — never
// creates one, so cooldown still doesn't litter a non-silo project. Self-contained + zero-dep so it works
// as the preinstall hook; lift this block out if cooldown is ever extracted to a generic installer.
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json"];
const lockHash = () => {
	for (const f of LOCKFILES) { try { return createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12); } catch { /* absent — try the next */ } }
	return null;
};
const siloDir = () => {   // nearest ancestor holding `.silo/` — mirrors paths.ts findRoot's authoritative anchor
	for (let dir = process.cwd(); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".silo"))) { return join(dir, ".silo"); }
		if (dirname(dir) === dir) { return null; }
	}
};
const lockBefore = lockHash();   // capture BEFORE the install (and before the npm path rm's the lockfile)
const markPendingReview = () => {
	const dir = siloDir();

	if (dir === null) { return; }                       // not a silo-governed project — nothing to flag
	const lockAfter = lockHash();

	if (lockAfter === lockBefore) { return; }           // resolution unchanged — no new surface to re-review
	writeFileSync(join(dir, "pending-review.json"), JSON.stringify({ "at": new Date().toISOString(), "reason": "cooldown install", "cooldownDays": days, "lockBefore": lockBefore, "lockAfter": lockAfter }, undefined, 2) + "\n");
	process.stderr.write("[silo cooldown] dependencies changed — flagged for re-review (.silo/pending-review.json)\n");
};

process.stderr.write(`[silo cooldown] pnpm install --config.minimumReleaseAge=${minutes}  (newest release ≥${days}d old)\n`);
const pnpm = spawnSync("pnpm", ["install", `--config.minimumReleaseAge=${minutes}`, ...pass], { "stdio": "inherit", "env": guardEnv });

if (!pnpm.error && pnpm.status === 0) { markPendingReview(); process.exit(0); }

// No pnpm on PATH, or the pnpm install itself failed — fall back to npm. Force a fresh cooled
// resolution: npm writes a hidden node_modules/.package-lock.json pinning the NEWEST versions *before*
// this hook runs, and it would otherwise override --before. Clearing both the hidden lock (via
// node_modules) and any stale top-level lock makes --before authoritative. pnpm needs none of this.
rmSync("node_modules", { "recursive": true, "force": true });
rmSync("package-lock.json", { "force": true });

process.stderr.write(`[silo cooldown] npm install --before=${before}  (newest release ≥${days}d old)\n`);
const npm = spawnSync("npm", ["install", `--before=${before}`, ...pass], { "stdio": "inherit", "env": guardEnv });

if ((npm.status ?? 1) !== 0) {
	process.stderr.write(`\n[silo cooldown] npm install failed (exit ${npm.status}). If "notarget"/"ENOVERSIONS", a (sub)dependency has no release older than your ${days}-day cooldown — too fresh to trust yet. Wait it out, or run with --cooldown <days>.\n`);
} else {
	markPendingReview();
}

process.exit(npm.status ?? 0);
