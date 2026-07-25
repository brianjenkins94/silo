/**
 * Shared UnitProvider machinery — the review-axis compute loop, parameterized by a "kernel" (silo's
 * unitsOfSource / understoodOf / attributedTransforms). The kernel is resolved once, asynchronously, by `load`:
 * the web provider import()s the served oxc-wasm core (provider-core.ts); the native provider returns the
 * directly-imported cores (provider-native.ts). Kept oxc-free (types only) so the web bundle — which pulls this
 * + provider-core — doesn't inline the parser.
 */
import { Range } from "vscode";
import type { BakedUnit, ResolvedUnit, UnitProvider } from "./overlay";
import type { ReviewRecord, ReviewStore, Understood } from "../../../commands/review-core";
import type { AttributedTransform } from "../../../commands/session-core";

export interface Kernel {
	"unitsOfSource": (file: string, src: string) => { "id": string; "hash": string; "startLine": number; "endLine": number }[];
	"understoodOf": (record: ReviewRecord | undefined, hash: string) => Understood;
	"attributedTransforms": (focalId: string, baseline: Record<string, string>, final: Record<string, string>) => AttributedTransform[];
}

export function makeProvider(load: () => Promise<Kernel | undefined>): UnitProvider {
	let kernel: Kernel | undefined;
	const range = (startLine: number, endLine: number) => new Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0);

	return {
		"init": async () => { kernel = await load(); },

		"resolve": (document, units, store: ReviewStore) => {
			const out = new Map<string, ResolvedUnit>();
			const file = units[0]?.file;

			if (kernel === undefined || file === undefined) { return Promise.resolve(out); }

			// silo's real unit detection + hashing over the CURRENT document text.
			const live = new Map(kernel.unitsOfSource(file, document.getText()).map((u) => [u.id, u]));

			for (const unit of units as readonly BakedUnit[]) {
				const u = live.get(unit.id);

				if (u === undefined) {
					// In the baked snapshot but not the live parse (renamed/removed) — keep the baked verdict.
					out.set(unit.id, { "range": range(unit.startLine, unit.endLine), "understood": unit.understood, "hash": unit.hash ?? "" });

					continue;
				}

				// understood = silo's hash-anchored comparison against the store — identical to the CLI.
				out.set(unit.id, { "range": range(u.startLine, u.endLine), "understood": kernel.understoodOf(store[unit.id], u.hash), "hash": u.hash });
			}

			return Promise.resolve(out);
		},

		"attributedTransforms": (focalId, baseline, final) => Promise.resolve(kernel === undefined ? [] : kernel.attributedTransforms(focalId, baseline, final))
	};
}
