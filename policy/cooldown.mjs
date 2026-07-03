/**
 * Release-age cooldown installer — the repo's `preinstall` hook AND the engine behind `silo install`.
 *
 * Policy: float to the newest release, but never one published within the last N days (default 7), so a
 * freshly-compromised version can't land during its highest-risk window. With deps pinned to "latest"
 * and no committed lockfile, a bare `npm install` then always resolves to newest-that's-≥N-days-old.
 *
 * Why a hook can pull this off: npm fixes versions at resolution time from startup config, and a
 * lifecycle script can't alter the parent's resolution. So instead this RE-RUNS the install itself with
 * `--before=<now − N days>`, guarded against recursion. The parent `npm install` then honors the cooled
 * lockfile this wrote and exits 0 — no wrapper, no abort.
 *
 * Pure Node, zero deps on purpose: `preinstall` runs BEFORE node_modules exists, so tsx / silo's own
 * packages aren't available yet — which is also why the preinstall can't just be `silo install`.
 *
 * Run directly too:  node policy/cooldown.mjs [--cooldown <days>] [npm-install-args…]
 */
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

// When we spawn `npm install` below, npm re-fires this same hook — the guard makes the inner run a
// no-op so npm proceeds with our --before resolution instead of recursing forever.
if (process.env.SILO_COOLDOWN_GUARD) process.exit(0);

let days = Number(process.env.SILO_COOLDOWN_DAYS) || 7;
const pass = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--cooldown") days = Number(argv[++i]);
	else if (argv[i].startsWith("--cooldown=")) days = Number(argv[i].slice("--cooldown=".length));
	else pass.push(argv[i]);
}
if (!Number.isFinite(days) || days < 0) days = 7;
const before = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

// Force a fresh cooled resolution: npm writes a hidden node_modules/.package-lock.json pinning the
// NEWEST versions *before* this hook runs, and it would otherwise override --before. Clearing both the
// hidden lock (via node_modules) and any stale top-level lock makes --before authoritative.
rmSync("node_modules", { recursive: true, force: true });
rmSync("package-lock.json", { force: true });

process.stderr.write(`[silo cooldown] npm install --before=${before}  (newest release ≥${days}d old)\n`);
const r = spawnSync("npm", ["install", `--before=${before}`, ...pass], {
	stdio: "inherit",
	env: { ...process.env, SILO_COOLDOWN_GUARD: "1" },
});
if ((r.status ?? 1) !== 0) {
	process.stderr.write(`\n[silo cooldown] npm install failed (exit ${r.status}). If "notarget"/"ENOVERSIONS", a (sub)dependency has no release older than your ${days}-day cooldown — too fresh to trust yet. Wait it out, or run with --cooldown <days>.\n`);
}
process.exit(r.status ?? 0);
