/**
 * The WEB / harness provider: import()s the served oxc-wasm core (core.js — the current threaded
 * binding-wasm32-wasi, served at /__vscode__/core.js; it runs because the harness is crossOriginIsolated) and
 * hands it to makeProvider as the kernel. The browser host can't statically import ESM, but a runtime import()
 * bypasses the guard. Kept oxc-free (import()'d, not bundled). Shipped desktop uses native oxc (provider-native.ts).
 */
import { type Kernel, makeProvider } from "./provider";
import type { UnitProvider } from "./overlay";

export function coreProvider(): UnitProvider {
	return makeProvider(async () => {
		// A variable specifier keeps esbuild from bundling this; same-origin so the core's worker isn't cross-origin.
		const url = location.origin + "/__vscode__/core.js";

		try { return await import(url) as Kernel; } catch (error) { console.error("[silo] oxc core failed to load — overlay empty", error); return undefined; }
	});
}
