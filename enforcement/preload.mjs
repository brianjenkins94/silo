/**
 * PROTOTYPE — runtime preload (the in-process alternative to instrument.ts's bundle-and-run box):
 *
 *   node --import ./enforcement/preload.mjs <script>
 *   NODE_OPTIONS="--import /abs/enforcement/preload.mjs" node <anything>   # ambient gating
 *
 * Importing the broker activates net gating (globalThis.fetch override) + allowlist + JUDICIAL/BERNARD.
 * Then module.registerHooks (sync, CJS+ESM, Node ≥22.15) intercepts node:fs / node:child_process at
 * LOAD time and substitutes a wrapped module — same gate logic as the esbuild plugin, but no bundling,
 * running the REAL file, and catching dynamic import()/createRequire (which the static bundle misses).
 * The wrapped module gets the real builtin via process.getBuiltinModule (bypasses these hooks → no loop).
 */
import { registerHooks } from "node:module";
import "./capability-broker.mjs"; // runs first → fetch override + banner + allowlist/JUDICIAL/BERNARD

const BROKER = new URL("./capability-broker.mjs", import.meta.url).href;

const CAP_FS = {
	"readFileSync": "read",
	"readFile": "read",
	"existsSync": "read",
	"statSync": "read",
	"readdirSync": "read",
	"createReadStream": "read",
	"writeFileSync": "write",
	"writeFile": "write",
	"appendFileSync": "write",
	"mkdirSync": "write",
	"unlinkSync": "write",
	"rmSync": "write",
	"renameSync": "write",
	"createWriteStream": "write"
};
const CAP_EXEC = new Set(["execFileSync", "execSync", "exec", "execFile", "spawnSync", "spawn", "fork"]);
const TARGETS = { "fs": { "caps": CAP_FS, "gate": "gateFsSync" }, "child_process": { "caps": CAP_EXEC, "gate": "gateExecSync" } };

registerHooks({
	"load": function(url, context, nextLoad) {
		const base = url.replace(/^node:/, "").split("?")[0];
		const t = TARGETS[base];

		if (!t) { return nextLoad(url, context); }
		const real = process.getBuiltinModule("node:" + base);
		const keys = Object.keys(real).filter((k) => /^[A-Z_$][\w$]*$/i.test(k));
		let src = `import { ${t.gate} } from ${JSON.stringify(BROKER)};\n`;

		src += `const real = process.getBuiltinModule(${JSON.stringify("node:" + base)});\n`;
		src += `const w = Object.assign(Object.create(null), real);\n`;
		for (const k of keys) {
			const isCap = t.caps instanceof Set ? t.caps.has(k) : k in t.caps;

			if (isCap) {
				const arg = t.gate === "gateFsSync" ? `${JSON.stringify(t.caps[k])}, a[0]` : "a[0]";

				src += `w.${k} = (...a) => { ${t.gate}(${arg}); return real.${k}(...a); };\n`;
			}
		}

		src += `export default w;\n`;
		for (const k of keys) { src += `export const ${k} = w[${JSON.stringify(k)}];\n`; }

		return { "format": "module", "source": src, "shortCircuit": true };
	}
});
