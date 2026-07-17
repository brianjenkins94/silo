/**
 * Where silo keeps its state, and how it finds the project root. Every other module hangs off these —
 * the one place that knows the `.silo/` layout and the dev-vs-built (tsx/.ts vs node/.js) runner split.
 */
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";

/** Resolve the silo root, git-`.git`-style. The nearest ancestor holding a `.silo/` is authoritative —
 *  you pick the scope by where you commit it (monorepo root → one baseline; sub-package → its own). If
 *  none exists yet, choose where to init: nearest workspace root (package.json `workspaces` /
 *  pnpm-workspace.yaml), else nearest package.json, else cwd. */
export function findRoot(start: string): string {
	const has = (name: string) => (d: string) => fs.existsSync(path.join(d, name));
	const isWorkspaceRoot = (d: string) => {
		if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) { return true; }
		try { return Boolean(JSON.parse(fs.readFileSync(path.join(d, "package.json"))).workspaces); } catch { return false; }
	};

	// `fs.closest` walks ancestors and returns the first dir a predicate accepts (or undefined). A committed
	// `.silo/` is authoritative; else init at the nearest workspace root, then nearest package.json, then cwd.
	return fs.closest(start, has(".silo")) ?? fs.closest(start, isWorkspaceRoot) ?? fs.closest(start, has("package.json")) ?? start;
}

export const TOOL = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");   // repo root — paths lives in shared/, so `..`; spawned engines (detect/, enforce/), install/, node_modules resolve from here
export const PROJECT = findRoot(process.cwd());                                      // project / workspace root (anchored by .silo)
export const SILO_DIR = path.join(PROJECT, ".silo");                                 // state + baseline (commit baseline.json)

export const REGISTRY = path.join(SILO_DIR, "registry.json");
export const BASELINE = path.join(SILO_DIR, "baseline.json");
export const LEDGER = path.join(SILO_DIR, "runs.jsonl");
export const FINGERPRINTS = path.join(SILO_DIR, "fingerprints.json");
// Family-C breadcrumb: written by install/cooldown.mjs when an install changes the lockfile, read by the
// runner/audit to escalate a re-review, then cleared once handled. Transient + per-clone (gitignored).
// cooldown.mjs hard-codes this same relative path ("`.silo/pending-review.json`"), being pre-node_modules.
export const PENDING_REVIEW = path.join(SILO_DIR, "pending-review.json");

/** Create `.silo/` lazily — only audit/baseline/run own state; `silo install` (cooldown) must not litter it.
 *  Seeds the gitignore for everything derived (only baseline.json + review.json are committed). */
export async function ensureSiloDir(): Promise<void> {
	if (!fs.existsSync(SILO_DIR)) {
		await fs.mkdir(SILO_DIR, { "recursive": true });
		fs.writeFileSync(path.join(SILO_DIR, ".gitignore"), "registry.json\nruns.jsonl\nfingerprints.json\neslintcache\npending-review.json\n");
	}
}

/** The Family-C breadcrumb (see PENDING_REVIEW). `readPending` → the parsed marker or null; `clearPending`
 *  → remove it once the dep change has been reviewed. The write side is install/cooldown.mjs. */
export interface Pending { "at": string; "reason": string; "cooldownDays": number; "lockBefore": string | null; "lockAfter": string }
export function readPending(): Pending | null {
	try { return JSON.parse(fs.readFileSync(PENDING_REVIEW)); } catch { return null; }
}
export async function clearPending(): Promise<void> { await fs.rm(PENDING_REVIEW, { "force": true }); }

// Published dist runs as .js under plain node; in dev we run the .ts sources via tsx. Spawned helpers
// (the LSP engine, the box) follow suit: node + .js when built, tsx + .ts in dev.
export const BUILT = import.meta.url.endsWith(".js");
export const RUNNER = BUILT ? [process.execPath] : [path.join(TOOL, "node_modules/.bin/tsx")];
export const CAP_ENGINE = path.join(TOOL, "detect/static-lsp" + (BUILT ? ".js" : ".ts"));
export const BOX_TS = path.join(TOOL, "enforce/box" + (BUILT ? ".js" : ".ts"));
