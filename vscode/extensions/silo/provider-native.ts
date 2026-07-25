/**
 * The NATIVE / Node-host provider (shipped desktop): review-core/session-core imported directly on native
 * oxc-parser (bundled by package-vsix.ts, oxc-parser external → node_modules) — synchronous, no wasm/worker/SAB.
 * Warms the parser once so a failure surfaces at init. Byte-identical to the CLI. Web harness uses provider-core.ts.
 */
import { understoodOf, unitsOfSource } from "../../../commands/review-core";
import { attributedTransforms } from "../../../commands/session-core";
import { makeProvider } from "./provider";
import type { UnitProvider } from "./overlay";

export function nativeProvider(): UnitProvider {
	return makeProvider(() => {
		try {
			unitsOfSource("warmup.ts", "");   // trigger init here so a failure surfaces before the overlay runs

			return Promise.resolve({ unitsOfSource, understoodOf, attributedTransforms });
		} catch (error) {
			console.error("[silo] oxc-parser failed to init — overlay empty", error);

			return Promise.resolve(undefined);
		}
	});
}
