/**
 * PROTOTYPE — "box" a script: bundle it with the broker injected and node:fs / node:child_process
 * rewritten to brokered wrappers, so every capability call (net via the broker prelude, fs/exec via
 * the rewritten imports) is gated. Bundling is the only place to wrap builtin named imports uniformly.
 *
 *   tsx enforcement/instrument.ts <script> <outfile>
 *
 * The brokered wrapper enumerates the real module's exports at build time, wraps the capability-
 * bearing ones with a gate, and passes the rest through (so arbitrary imports still resolve). The
 * wrapper gets the real builtin at runtime via createRequire (bypassing this rewrite).
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const esbuild = require(path.join(ROOT, "node_modules/esbuild"));
const BROKER = path.join(ROOT, "enforcement/capability-broker.mjs");

const CAP_FS: Record<string, "read" | "write"> = {
	readFileSync: "read", readFile: "read", existsSync: "read", statSync: "read", readdirSync: "read", createReadStream: "read",
	writeFileSync: "write", writeFile: "write", appendFileSync: "write", mkdirSync: "write", unlinkSync: "write", rmSync: "write", renameSync: "write", createWriteStream: "write",
};
const CAP_EXEC = new Set(["execFileSync", "execSync", "exec", "execFile", "spawnSync", "spawn", "fork"]);

const plugin = {
	name: "cap-broker",
	setup(build: any) {
		build.onResolve({ filter: /^node:(fs|child_process)$/ }, (a: any) => ({ path: a.path, namespace: "brokered" }));
		build.onLoad({ filter: /.*/, namespace: "brokered" }, (a: any) => {
			const mod = a.path;
			const real = require(mod);
			const wrap = mod === "node:fs" ? "gateFsSync" : "gateExecSync";
			let src = `import { createRequire as __cr } from "node:module";\nconst __real = __cr(import.meta.url)(${JSON.stringify(mod)});\nimport { ${wrap} } from ${JSON.stringify(BROKER)};\n`;
			for (const k of Object.keys(real)) {
				if (!/^[A-Za-z_$][\w$]*$/u.test(k)) continue;
				if (mod === "node:fs" && CAP_FS[k]) src += `export const ${k} = (...a) => { ${wrap}(${JSON.stringify(CAP_FS[k])}, a[0]); return __real.${k}(...a); };\n`;
				else if (mod === "node:child_process" && CAP_EXEC.has(k)) src += `export const ${k} = (...a) => { ${wrap}(a[0]); return __real.${k}(...a); };\n`;
				else src += `export const ${k} = __real[${JSON.stringify(k)}];\n`;
			}
			return { contents: src, loader: "js", resolveDir: ROOT };
		});
	},
};

const [script, out] = process.argv.slice(2);
const entry = path.join("/private/tmp", `box-entry-${process.pid}.mjs`);
writeFileSync(entry, `import ${JSON.stringify(BROKER)};\nimport ${JSON.stringify(path.resolve(script))};\n`);
await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, plugins: [plugin], logLevel: "error" });
process.stderr.write(`boxed ${path.basename(script)} → ${out}\n`);
