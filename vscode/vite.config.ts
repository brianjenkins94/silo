import { defineConfig } from "vite";
import { siloReviewPlugin, siloWorkspacePlugin } from "./snapshot";
import { vscodePlugin } from "./vite";

// Host app for the silo review view — index.html + main.tsx mount the monaco workbench (createVscodeWindow
// from ./vscode.tsx). `vite build vscode` → ../docs (relative base, so it works at any Pages subpath);
// `vite vscode` serves it in dev. The workbench iframe entry is a SEPARATE build (entry.config.ts → dist/),
// which vscodePlugin serves at /__vscode__/ alongside monaco-vscode-api's own dist.
export default defineConfig({
	"base": "./",
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	// One Preact instance across chunks (the lazily-imported workbench chunk shares hooks state).
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime"] },
	"build": { "outDir": "../docs", "emptyOutDir": true },
	"plugins": [
		// Cross-origin-isolate the host page so the workbench iframe can use SharedArrayBuffer. The iframe
		// inherits isolation from the (isolated) host only if its own responses carry COEP — vscodePlugin
		// sets that on /__vscode__/ responses. `credentialless` keeps cross-origin subresources working.
		{
			"name": "coi-headers",
			"configureServer": function(server) {
				server.middlewares.use(function(_req, res, next) {
					res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
					res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
					next();
				});
			}
		},
		// Bakes a git snapshot of the silo repo in as `silo:workspace`, and `silo review --json` as
		// `silo:review` (see main.tsx) — so the hosted page opens on real source with the review overlay.
		siloWorkspacePlugin(),
		siloReviewPlugin(),
		vscodePlugin()
	]
});
