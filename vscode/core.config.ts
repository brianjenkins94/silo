import * as url from "node:url";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const stub = url.fileURLToPath(new URL("./extensions/silo/node-stub.ts", import.meta.url));

/**
 * Builds silo's browser review CORE (oxc-wasm) into vscode/dist/ — the SAME dir the entry build uses and that
 * vscodePlugin already serves, so core.js lands at /__vscode__/core.js with no special-casing. vite — unlike
 * esbuild — resolves oxc-parser's `browser` build and emits its wasm + WASI worker as assets, so
 * `new URL('./parser…wasm', import.meta.url)` + the worker resolve at runtime.
 *
 * NOT an extension (the name is why: it used to build an ESM *extension*; that pivoted to the CJS extension
 * `await import()`ing this served core to bypass the host's ESM guard). `emptyOutDir:false` — the entry build
 * cleans `dist` and runs FIRST; this appends core.js next to workbench.js (see the dev/build script order).
 * Run by the `build:core` script. node:crypto → the sync SHA-256 shim (browser has no node:crypto).
 *
 * Requires the wasm binding: npm i --no-save --force @oxc-parser/binding-wasm32-wasi@0.137.0
 * (it's cpu:wasm32, so a plain install EBADPLATFORMs on other arches).
 */
export default defineConfig({
	// Relative asset URLs (`new URL('./assets/x', import.meta.url)`) so the wasm/worker resolve next to the
	// served core.js at /__vscode__/, not absolute-from-origin.
	"base": "./",
	// webcrack (the deps-in-browser cap path) is babel-based → needs `path`/`process`/`util`/`buffer` polyfilled;
	// its Node-sandbox branch (node:fs, isolated-vm) is dead in the browser but statically resolved, so stub it.
	"plugins": [nodePolyfills({ "include": ["path", "process", "util", "buffer", "events", "stream"], "globals": { "process": true, "Buffer": true } })],
	"resolve": {
		"alias": {
			"node:crypto": url.fileURLToPath(new URL("./extensions/silo/crypto-shim.ts", import.meta.url)),
			"node:fs/promises": stub,
			"fs/promises": stub,
			"node:fs": stub,
			"fs": stub,
			"isolated-vm": stub
		}
	},
	"worker": { "format": "es" },
	"build": {
		"outDir": "dist",
		"emptyOutDir": false,
		"target": "esnext",
		"minify": true,
		"rollupOptions": {
			"input": url.fileURLToPath(new URL("./extensions/silo/core-browser.ts", import.meta.url)),
			"external": ["vscode"],
			// Keep the entry's re-exports (unitsOfSource/understoodOf) — else rollup tree-shakes them (nothing
			// internal consumes them) and the dynamic import() sees no named exports.
			"preserveEntrySignatures": "strict",
			"output": { "entryFileNames": "core.js", "format": "es" }
		}
	}
});
