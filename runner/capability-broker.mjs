/**
 * PROTOTYPE — enforcing capability broker (injected into the bundle by instrument.ts, runs first).
 *
 * Gates net (async prompt), fs and exec (SYNC prompt via readSync(0) — sync builtins can't await).
 * Allowlists come from env (set by `run` from the registry's approved scopes); a `y` grant is TOFU
 * for the session and appended to GRANT_LOG so `run` can persist it. The broker uses the REAL fs via
 * createRequire so it isn't caught by its own node:fs rewrite.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const realFs = require("node:fs");

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW = { net: list(process.env.ALLOW_NET ?? "localhost"), fs: list(process.env.ALLOW_FS), exec: list(process.env.ALLOW_EXEC) };
const GRANT_LOG = process.env.GRANT_LOG;
const granted = new Set();

const grant = (scope) => { granted.add(scope); if (GRANT_LOG) { try { realFs.appendFileSync(GRANT_LOG, scope + "\n"); } catch {} } process.stderr.write(`[broker] granted ${scope}\n`); };

function askSync(q) {
	process.stderr.write(q);
	const buf = Buffer.alloc(64);
	try { const n = realFs.readSync(0, buf, 0, 64, null); return buf.toString("utf8", 0, n).trim().toLowerCase(); } catch { return "n"; }
}
function askAsync(q) {
	return new Promise((res) => {
		process.stderr.write(q);
		const on = (d) => { process.stdin.off("data", on); process.stdin.pause(); res(d.toString().trim().toLowerCase()); };
		process.stdin.on("data", on); process.stdin.resume();
	});
}
const yes = (a) => a === "y" || a === "yes";

const netOk = (host) => { const n = host.split(":")[0]; return granted.has("net:" + host) || ALLOW.net.some((a) => n === a || n.endsWith("." + a)); };
const fsOk = (p) => granted.has("fs:" + p) || ALLOW.fs.some((a) => p.startsWith(a));
const execOk = (b) => granted.has("exec:" + b) || ALLOW.exec.some((a) => b === a || b.endsWith("/" + a) || b.endsWith("/" + a + ".js"));

export async function gateNet(host) {
	if (netOk(host)) return;
	if (yes(await askAsync(`\n[broker] ⚠ net:${host} not allowed. Allow this run? [y/N] `))) return grant("net:" + host);
	throw new Error(`[broker] DENIED net:${host}`);
}
export function gateFsSync(op, p) {
	const abs = String(p);
	if (fsOk(abs)) return;
	if (yes(askSync(`\n[broker] ⚠ fs:${op} ${abs} not allowed. Allow this run? [y/N] `))) return grant(`fs:${op}:${abs}`);
	throw new Error(`[broker] DENIED fs:${op}:${abs}`);
}
export function gateExecSync(cmd) {
	const b = String(cmd);
	if (execOk(b)) return;
	if (yes(askSync(`\n[broker] ⚠ exec ${b} not allowed. Allow this run? [y/N] `))) return grant("exec:" + b);
	throw new Error(`[broker] DENIED exec:${b}`);
}

const realFetch = globalThis.fetch;
if (realFetch) globalThis.fetch = async function (input, init) {
	let host = "*"; try { host = new URL(typeof input === "string" ? input : input.url).host; } catch {}
	await gateNet(host); return realFetch.call(this, input, init);
};
process.stderr.write(`[broker] active — net:[${ALLOW.net.join(",") || "∅"}] fs:[${ALLOW.fs.join(",") || "∅"}] exec:[${ALLOW.exec.join(",") || "∅"}]\n`);
