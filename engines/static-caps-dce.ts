/**
 * PROTOTYPE — per-export capability fingerprint via Vite/rollup tree-shaking.
 *
 * For each value-export E of a module, bundle a virtual entry that imports only E, tree-shake
 * aggressively (moduleSideEffects:false drops the rest, incl. the CLI entry-guard), then detect
 * capabilities by *usage* in the surviving code. DCE removes unreachable function bodies, so a
 * capability call only appears if E transitively reaches it.
 *
 * Run: ./node_modules/.bin/tsx scripts/engines/static-caps-dce.ts [targetFile]
 */
import * as fs from "@brianjenkins94/util/fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { detect } from "../vocabulary/capability-detectors.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VITE = path.join(ROOT, "node_modules/vite/dist/node/index.js");
const target = path.resolve(process.argv[2] ?? path.join(ROOT, "engines/static-caps-dce.ts"));

// capabilities are detected by the shared core (capability-detectors.ts), run against the tree-shaken text.

function valueExports(src: string): string[] {
	const names = new Set<string>();

	for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gmu)) { names.add(m[1]); }
	for (const m of src.matchAll(/^export\s+const\s+(\w+)/gmu)) { names.add(m[1]); }

	return [...names];
}

async function capsOf(vite: any, tmp: string, exportName: string): Promise<string[]> {
	const entry = path.join(tmp, `entry-${exportName}.mjs`);

	fs.writeFileSync(entry, `import { ${exportName} } from ${JSON.stringify(target)};\nif (globalThis.__never) console.log(${exportName});\n`);

	const result = await vite.build({
		"configFile": false,
		"logLevel": "silent",
		"plugins": [{
			// Strip the module's self-run guard (`if (import.meta.url === …) main()`) so its top-level
			// execution doesn't drag main()'s capabilities into every export's bundle. Prototype: regex
			// from the guard to EOF; a real impl drops top-level side-effect statements via the AST.
			"name": "strip-entry-guard",
			"enforce": "pre",
			"transform": function(code: string, id: string) {
				if (path.resolve(id.split("?")[0]) === target) {
					return code.replace(/\n?if\s*\(\s*import\.meta\.url[\s\S]*$/u, "\n");
				}
			}
		}],
		"build": {
			"write": false,
			"minify": false,
			"target": "esnext",
			"rollupOptions": {
				"input": entry,
				"external": (id: string) => id.startsWith("node:") || /^[a-z@]/i.test(id),
				"treeshake": { "moduleSideEffects": false },
				"output": { "format": "es" }
			}
		}
	});

	const code = (Array.isArray(result) ? result[0] : result).output[0].code as string;

	return detect(code);
}

const vite = await import(VITE);
const tmp = mkdtempSync(path.join(tmpdir(), "cap-"));
const exports = valueExports(fs.readFileSync(target));

console.log(`target: ${path.relative(process.cwd(), target)}   exports: ${exports.length}\n`);
const map: Record<string, string[]> = {};

for (const e of exports) { map[e] = await capsOf(vite, tmp, e); }

const width = Math.max(...exports.map((e) => e.length));

for (const e of exports) {
	const caps = map[e];

	console.log(`  ${e.padEnd(width)}  ${caps.length ? caps.join(", ") : "— pure —"}`);
}
