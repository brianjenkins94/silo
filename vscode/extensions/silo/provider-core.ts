/**
 * The unit provider — runs silo's REAL review kernel in the browser. The CJS extension host can't be an
 * ESM module (it guards `_loadESMModule`), but it CAN `await import()` at runtime — that path bypasses the
 * guard. So we dynamically import the served oxc-wasm core (core.js, built by core.config.ts into dist,
 * served at /__vscode__/core.js) and use its `unitsOfSource`/`understoodOf` — byte-identical to the CLI.
 *
 * So `understood` is silo's actual hash-anchored comparison against the store (not the old monaco-symbol
 * approximation): edit a reviewed function → its live hash diverges from the store record → `stale`.
 *
 * If the core fails to load (e.g. no SharedArrayBuffer / crossOriginIsolated), the overlay degrades to
 * empty rather than crashing.
 */
import * as vscode from "vscode";
import type { BakedUnit, ResolvedUnit, UnitProvider } from "./overlay";
import type { ReviewRecord, ReviewStore, Understood } from "../../../commands/review-core";

interface Core {
	"unitsOfSource": (file: string, src: string) => { "id": string; "hash": string; "startLine": number; "endLine": number }[];
	"understoodOf": (record: ReviewRecord | undefined, hash: string) => Understood;
}

export function coreProvider(): UnitProvider {
	let core: Core | undefined;
	const range = (startLine: number, endLine: number) => new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0);

	return {
		"init": async () => {
			// Served by vscodePlugin at /__vscode__/core.js (same-origin — a cross-origin worker would be
			// blocked). A variable specifier keeps esbuild from rewriting this into a bundled require().
			// (Origin-absolute path assumes the app is served at root; revisit for a Pages base subpath.)
			const url = location.origin + "/__vscode__/core.js";

			try { core = await import(url) as Core; } catch (error) { console.error("[silo] oxc core failed to load — overlay empty", error); }
		},

		"resolve": (document, units, store: ReviewStore) => {
			const out = new Map<string, ResolvedUnit>();
			const file = units[0]?.file;

			if (core === undefined || file === undefined) { return Promise.resolve(out); }

			// silo's real unit detection + hashing over the CURRENT document text.
			const live = new Map(core.unitsOfSource(file, document.getText()).map((u) => [u.id, u]));

			for (const unit of units as readonly BakedUnit[]) {
				const u = live.get(unit.id);

				if (u === undefined) {
					// In the baked snapshot but not the live parse (renamed/removed) — keep the baked verdict.
					out.set(unit.id, { "range": range(unit.startLine, unit.endLine), "understood": unit.understood, "hash": unit.hash ?? "" });

					continue;
				}

				// understood = silo's hash-anchored comparison against the store — identical to the CLI.
				out.set(unit.id, { "range": range(u.startLine, u.endLine), "understood": core.understoodOf(store[unit.id], u.hash), "hash": u.hash });
			}

			return Promise.resolve(out);
		}
	};
}
