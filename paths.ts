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
	for (let d = start; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, ".silo"))) { return d; } if (d === path.dirname(d)) { break; } }
	let pkg: string | null = null;

	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) { return d; }
		const pj = path.join(d, "package.json");

		if (fs.existsSync(pj)) { pkg ??= d; try { if (JSON.parse(fs.readFileSync(pj)).workspaces) { return d; } } catch { /* unparseable */ } }
		if (d === path.dirname(d)) { break; }
	}

	return pkg ?? start;
}

export const TOOL = path.resolve(path.dirname(new URL(import.meta.url).pathname));   // silo's own install — engines live here
export const PROJECT = findRoot(process.cwd());                                      // project / workspace root (anchored by .silo)
export const SILO_DIR = path.join(PROJECT, ".silo");                                 // state + baseline (commit baseline.json)

export const REGISTRY = path.join(SILO_DIR, "registry.json");
export const BASELINE = path.join(SILO_DIR, "baseline.json");
export const LEDGER = path.join(SILO_DIR, "runs.jsonl");
export const FINGERPRINTS = path.join(SILO_DIR, "fingerprints.json");

/** Create `.silo/` lazily — only audit/baseline/run own state; `silo install` (cooldown) must not litter it.
 *  Seeds the gitignore for everything derived (only baseline.json + review.json are committed). */
export async function ensureSiloDir(): Promise<void> {
	if (!fs.existsSync(SILO_DIR)) {
		await fs.mkdir(SILO_DIR, { "recursive": true });
		fs.writeFileSync(path.join(SILO_DIR, ".gitignore"), "registry.json\nruns.jsonl\nfingerprints.json\neslintcache\n");
	}
}

// Published dist runs as .js under plain node; in dev we run the .ts sources via tsx. Spawned helpers
// (the LSP engine, the box) follow suit: node + .js when built, tsx + .ts in dev.
export const BUILT = import.meta.url.endsWith(".js");
export const RUNNER = BUILT ? [process.execPath] : [path.join(TOOL, "node_modules/.bin/tsx")];
export const CAP_ENGINE = path.join(TOOL, "engines/static-caps-lsp" + (BUILT ? ".js" : ".ts"));
export const BOX_TS = path.join(TOOL, "enforcement/instrument" + (BUILT ? ".js" : ".ts"));
