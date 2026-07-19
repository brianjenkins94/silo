/**
 * Bakes a snapshot of the silo repo into the build as the virtual module `silo:workspace`, so the
 * hosted workbench (GitHub Pages) opens on REAL silo source — not a fixture, not blank. main.tsx
 * imports it and hands it to `createVscodeWindow({ files })`.
 *
 * Source of truth = git, the same notion silo's own review.ts uses. `git ls-files --cached --others
 * --exclude-standard` = tracked PLUS untracked-but-not-ignored files, i.e. the working tree minus
 * whatever .gitignore drops (node_modules, docs/) — which is exactly "a copy of silo". Run from the
 * repo ROOT (from a subdir, ls-files lists only that subdir), text files only, size-capped.
 *
 * Simpler than games' equivalent on purpose: no node_modules type shims / tsconfig / launch.json
 * injection — this is a browse-and-review snapshot, not a live build environment.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const VIRTUAL = "silo:workspace";
const FOLDER = "/silo";                       // the explorer root the files mount under
const MAX_BYTES = 256 * 1024;                 // skip anything unexpectedly large (no lockfiles are tracked)

// Text/source extensions worth showing. Anything else (images, tarballs) is dropped; dotfiles
// (.gitignore) are kept regardless since they carry no extension.
const TEXT = new Set(["ts", "tsx", "mjs", "cjs", "js", "jsx", "json", "md", "yml", "yaml", "html", "css", "txt"]);

export interface SnapshotFile { "path": string; "contents": string }

function snapshot(): SnapshotFile[] {
	const here = path.dirname(fileURLToPath(import.meta.url));

	let root: string;
	let listed: string;

	try {
		root = execFileSync("git", ["rev-parse", "--show-toplevel"], { "cwd": here, "encoding": "utf8" }).trim();
		listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { "cwd": root, "encoding": "utf8", "maxBuffer": 32 * 1024 * 1024 });
	} catch {
		return [];   // not a git repo → empty (the workbench opens on an empty folder rather than crashing)
	}

	const files: SnapshotFile[] = [];

	for (const rel of listed.split("\n").filter(Boolean)) {
		if (rel.startsWith("docs/") || rel.includes("node_modules/") || rel.startsWith("vscode/dist/")) { continue; }

		const base = rel.slice(rel.lastIndexOf("/") + 1);
		const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();

		if (!TEXT.has(ext) && !base.startsWith(".")) { continue; }

		const absolute = path.join(root, rel);
		let stat;

		try { stat = statSync(absolute); } catch { continue; }
		if (!stat.isFile() || stat.size > MAX_BYTES) { continue; }

		files.push({ "path": `${FOLDER}/${rel}`, "contents": readFileSync(absolute, "utf8") });
	}

	return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function siloWorkspacePlugin(): Plugin {
	const resolved = "\0" + VIRTUAL;

	return {
		"name": "silo-workspace",
		"resolveId": (id) => (id === VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? `export default ${JSON.stringify(snapshot())};` : undefined)
	};
}

// ── Review units ──────────────────────────────────────────────────────────────────
//
// The other half of the seam: `silo review --json` run at build time, baked in as the virtual module
// `silo:review` (the raw JSON string). main.tsx writes it into the snapshot as `.silo/review-units.json`,
// which the silo extension reads back via workspace.fs to drive the overlay. Same idea as the workspace
// snapshot — there's no CLI in the browser, so the artifact is produced at build and shipped with the page.

const REVIEW_VIRTUAL = "silo:review";
let reviewCache: string | undefined;   // run the (eslint-spawning) review once per build process

function reviewJson(): string {
	if (reviewCache !== undefined) { return reviewCache; }

	const here = path.dirname(fileURLToPath(import.meta.url));

	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { "cwd": here, "encoding": "utf8" }).trim();

		// Call the bin directly (npm's run-banner would corrupt stdout). tsx runs cli.ts under Node.
		reviewCache = execFileSync("npx", ["tsx", "cli.ts", "review", "--json"], { "cwd": root, "encoding": "utf8", "maxBuffer": 64 * 1024 * 1024 }).trim();
	} catch {
		reviewCache = JSON.stringify({ "base": "", "units": [] });   // review unavailable → empty overlay, page still boots
	}

	return reviewCache;
}

export function siloReviewPlugin(): Plugin {
	const resolved = "\0" + REVIEW_VIRTUAL;

	return {
		"name": "silo-review",
		"resolveId": (id) => (id === REVIEW_VIRTUAL ? resolved : undefined),
		"load": (id) => (id === resolved ? `export default ${JSON.stringify(reviewJson())};` : undefined)
	};
}
