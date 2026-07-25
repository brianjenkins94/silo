import * as url from "node:url";
import { build } from "esbuild";
import { defineConfig, type Plugin } from "vite";

/**
 * Bundles the silo extension (extension.ts → CJS) into a string exposed as `silo:extension`;
 * workbench-entry registers it via a data: URL. `vscode` stays external (the host injects it).
 *
 * This is the HARNESS/web build (browser web-worker host). The extension is CJS but at RUNTIME it `await import()`s
 * the served oxc-wasm core (core.config.ts → dist/core.js, run by build:core, served at /__vscode__/core.js) —
 * bypassing the host's ESM-entry guard. The shipped desktop extension is a separate Node-host build with native
 * oxc-parser (extension-node.ts → package-vsix.ts).
 */
function siloExtension(): Plugin {
	const id = "silo:extension";
	const resolved = "\0" + id;
	const dir = url.fileURLToPath(new URL("./extensions/silo/", import.meta.url));

	return {
		"name": "silo-extension",
		"resolveId": (source) => (source === id ? resolved : undefined),
		"load": async (moduleId) => {
			if (moduleId !== resolved) { return undefined; }

			const result = await build({
				"entryPoints": [dir + "extension.ts"],
				"bundle": true,
				"write": false,
				"format": "cjs",
				"platform": "browser",
				"target": "esnext",
				"external": ["vscode"],
				"minify": true
			});

			return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
		}
	};
}

/**
 * Builds the iframe entry (workbench-entry.tsx → dist/workbench.js) that renders the composed
 * <Workbench/> and boots monaco. Lib's pre-built bundle is kept external and mapped to the sibling
 * `./main.js` (served alongside by vite.ts), so it isn't re-bundled into this small entry.
 */
export default defineConfig({
	"plugins": [siloExtension()],
	"esbuild": {
		"jsx": "automatic",
		"jsxImportSource": "preact"
	},
	"build": {
		"target": "esnext",
		"outDir": "dist",
		"emptyOutDir": true,
		"minify": true,
		"rollupOptions": {
			"input": { "workbench": "workbench-entry.tsx" },
			"external": ["@brianjenkins94/monaco-vscode-api/main"],
			"output": {
				"format": "es",
				"entryFileNames": "[name].js",
				"chunkFileNames": "[name].js",
				"paths": { "@brianjenkins94/monaco-vscode-api/main": "./main.js" }
			}
		}
	}
});
