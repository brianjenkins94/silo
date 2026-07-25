/**
 * Stages the silo extension as a Node-host VS Code extension (→ vscode/dist-vsix/), the shipped product form.
 * It runs in the Node extension host (desktop VS Code) on the NATIVE `oxc-parser` binding — byte-identical to
 * the CLI, no wasm, no worker, no SharedArrayBuffer, no crossOriginIsolation. `oxc-parser` + its platform
 * binding ship as node_modules (a native `.node` can't be bundled), so the .vsix is platform-specific.
 *
 *   npx tsx vscode/package-vsix.ts     # stage the folder
 *   code --extensionDevelopmentPath="$PWD/vscode/dist-vsix" --new-window <some folder>   # load in the dev host
 *   npx @vscode/vsce package           # from vscode/dist-vsix (optional — a folder loads too)
 */
import { build } from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

const root = url.fileURLToPath(new URL(".", import.meta.url));
const repo = path.join(root, "..");
const extDir = path.join(root, "extensions/silo");
const stage = path.join(root, "dist-vsix");

await fs.rm(stage, { "recursive": true, "force": true });
await fs.mkdir(stage, { "recursive": true });

// Node-host bundle: `vscode` is host-injected; native `oxc-parser` stays external (shipped as node_modules below).
await build({
	"entryPoints": [path.join(extDir, "extension-node.ts")],
	"bundle": true,
	"outfile": path.join(stage, "extension.js"),
	"format": "cjs",
	"platform": "node",
	"target": "node18",
	"external": ["vscode", "oxc-parser"],
	"minify": true
});

// Vendor oxc-parser + the native platform binding it requires at runtime (the .node can't be bundled).
async function vendor(pkg: string): Promise<void> {
	await fs.cp(path.join(repo, "node_modules", pkg), path.join(stage, "node_modules", pkg), { "recursive": true });
}

await vendor("oxc-parser");

for (const dep of await fs.readdir(path.join(repo, "node_modules/@oxc-parser"))) {
	if (dep.startsWith("binding-") && !dep.includes("wasm")) { await vendor(`@oxc-parser/${dep}`); }
}

// Manifest: Node host → `main` (not the harness's `browser`); concrete engine range for vsce.
const manifest = JSON.parse(await fs.readFile(path.join(extDir, "package.json"), "utf8")) as Record<string, unknown>;

delete manifest.browser;
manifest.main = "extension.js";
manifest.engines = { "vscode": "^1.75.0" };
await fs.writeFile(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await fs.writeFile(path.join(stage, "README.md"), "# silo\n\nEarned, bounded trust for scripts — the review overlay.\n");

console.log("staged Node-host extension → " + path.relative(process.cwd(), stage));
