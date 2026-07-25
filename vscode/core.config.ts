import * as url from "node:url";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

/**
 * Builds silo's browser review CORE (the current threaded @oxc-parser/binding-wasm32-wasi) into vscode/dist/ →
 * core.js + its wasm/WASI-worker assets, served at /__vscode__/core.js. vite — unlike esbuild — resolves
 * oxc-parser's `browser` build and emits the wasm + worker as assets. WEB/harness only (it runs because the
 * harness is crossOriginIsolated); the shipped desktop extension uses native oxc-parser (package-vsix.ts).
 *
 * `emptyOutDir:false` — the entry build cleans `dist` and runs FIRST; this appends core.js (see the dev/build
 * script order). node:crypto → the sync SHA-256 shim (the browser has no node:crypto).
 *
 * Requires the wasm binding (cpu:wasm32 → a plain install EBADPLATFORMs; build:core installs it on demand):
 *   npm i --no-save --force @oxc-parser/binding-wasm32-wasi@0.140.0
 */
export default defineConfig({
	// Relative asset URLs (`new URL('./assets/x', import.meta.url)`) so the wasm/worker resolve next to core.js.
	"base": "./",
	// oxc's WASI runtime references `process.*` + `Buffer` as globals — polyfill those (NOT for webcrack; the
	// deps-in-browser cap path that needed node:fs/isolated-vm stubs was dropped).
	"plugins": [nodePolyfills({ "include": ["buffer", "process"], "globals": { "process": true, "Buffer": true } })],
	"resolve": { "alias": { "node:crypto": url.fileURLToPath(new URL("./extensions/silo/crypto-shim.ts", import.meta.url)) } },
	"worker": { "format": "es" },
	"build": {
		"outDir": "dist",
		"emptyOutDir": false,
		"target": "esnext",
		"minify": true,
		"rollupOptions": {
			"input": url.fileURLToPath(new URL("./extensions/silo/core-browser.ts", import.meta.url)),
			"external": ["vscode"],
			// Keep the entry's re-exports (unitsOfSource/…) — else rollup tree-shakes them (nothing internal
			// consumes them) and the dynamic import() sees no named exports.
			"preserveEntrySignatures": "strict",
			"output": { "entryFileNames": "core.js", "format": "es" }
		}
	}
});
