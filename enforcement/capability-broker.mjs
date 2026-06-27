/**
 * PROTOTYPE — enforcing capability broker (injected into the bundle by instrument.ts, runs first).
 *
 * Gates net (async prompt), fs and exec (SYNC prompt via readSync(0) — sync builtins can't await).
 * Allowlists come from env (set by `run` from the registry's approved scopes); a grant is TOFU for the
 * session and appended to GRANT_LOG so `run` can persist it. The broker uses the REAL fs via
 * createRequire so it isn't caught by its own node:fs rewrite.
 *
 * DECISION SOURCE is pluggable via the JUDICIAL env (mirrors the Agent SDK's canUseTool /
 * PermissionResult): unset → interactive TTY prompt; "allow"/"deny" → blanket (≈ bypass / dontAsk);
 * otherwise a command that receives the request JSON on stdin and prints a verdict
 *   { behavior: "allow", scope?, persist? }  |  { behavior: "deny", message }
 * (allow may rewrite to a NARROWER scope). The judiciary runs in the parent/trusted context, not the
 * box — it out-ranks the script it judges. Errors/timeouts fail CLOSED.
 *
 * BERNARD outranks JUDICIAL: a redline tier for catastrophic scopes that NO decider may auto-approve
 * — only an attentive human via a one-time randomized break-glass challenge. Checked first in every
 * gate; never persisted; fails CLOSED with no TTY (so CI never runs a redline op unattended).
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const realFs = require("node:fs");
const realCp = require("node:child_process");

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW = { net: list(process.env.ALLOW_NET ?? "localhost"), fs: list(process.env.ALLOW_FS), exec: list(process.env.ALLOW_EXEC) };
const GRANT_LOG = process.env.GRANT_LOG;
const granted = new Set();

const grant = (scope) => { granted.add(scope); if (GRANT_LOG) { try { realFs.appendFileSync(GRANT_LOG, scope + "\n"); } catch {} } process.stderr.write(`[broker] granted ${scope}\n`); };

/**
 * Consult the judiciary (JUDICIAL env). Returns a verdict { behavior, scope?, message? }, or `null`
 * = "no judiciary configured, fall back to the TTY prompt". Synchronous (spawnSync) so it composes
 * with the sync fs/exec gates as well as the async net gate.
 */
function judicial(req) {
	const J = process.env.JUDICIAL;
	if (!J) return null;
	if (J === "allow") return { behavior: "allow" };
	if (J === "deny") return { behavior: "deny", message: "JUDICIAL=deny" };
	try {
		const r = realCp.spawnSync(J, { input: JSON.stringify(req), encoding: "utf8", shell: true });
		const v = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}");
		return v.behavior ? v : { behavior: "deny", message: "JUDICIAL: no verdict" };
	} catch (e) {
		return { behavior: "deny", message: "JUDICIAL error (fail closed): " + e.message };
	}
}

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

/** Apply a judicial verdict (allow → grant the possibly-narrowed scope; deny → throw). */
const applyVerdict = (v, scope) => {
	if (v.behavior === "allow") { process.stderr.write(`[broker] JUDICIAL allow ${v.scope || scope}\n`); return grant(v.scope || scope); }
	throw new Error(`[broker] DENIED ${scope} — JUDICIAL: ${v.message || "deny"}`);
};
const ctx = () => ({ script: process.env.SILO_SCRIPT, confidence: process.env.SILO_CONFIDENCE });

// ── BERNARD: the redline tier. Outranks JUDICIAL — for catastrophic scopes NO decider (policy/AI)
//    may auto-approve; only an attentive human via a one-time, randomized break-glass challenge.
//    Conservative by design (over-flagging is the safe bias). Never persisted; fails CLOSED with no TTY.
//    Always armed; the BERNARD env adds extra redline regexes (it tunes WHAT is redline, never WHO decides).
const REDLINE = [
	/^fs:write:.*\/\.(ssh|aws|gnupg|npmrc|netrc)\b/,                  // credentials
	/^fs:write:.*\/\.git\//,                                          // git internals
	/^fs:write:\/(etc|bin|sbin|usr|boot|dev|System|Library)\//,       // system dirs
	/^exec:.*\/?(dd|mkfs|fdisk|shutdown|reboot|halt|sh|bash|zsh|curl|wget|nc|ncat|rm)(\.\w+)?$/, // dangerous bins
	/^net:\*/,                                                        // indeterminate host
	/^eval\b/,                                                        // dynamic code
	...(process.env.BERNARD ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s)),
];
const redline = (scope) => REDLINE.some((re) => re.test(scope));
const brokenGlass = new Set();
function bernard(scope) {
	if (brokenGlass.has(scope)) return;                              // authorized once this session (never persisted)
	if (!process.stdin.isTTY) throw new Error(`[broker] DENIED ${scope} — BERNARD redline, no human present (fail-closed)`);
	const token = Math.random().toString(36).slice(2, 8).toUpperCase();
	process.stderr.write(`\n⛔ [BERNARD] REDLINE: ${scope}\n   Cannot be auto-approved. To authorize (one-time), type exactly: ${token}\n   > `);
	if (askSync("") === token.toLowerCase()) { brokenGlass.add(scope); process.stderr.write(`[broker] BERNARD authorized (one-time) ${scope}\n`); return; }
	throw new Error(`[broker] DENIED ${scope} — BERNARD challenge failed`);
}

export async function gateNet(host) {
	const scope = "net:" + host;
	if (redline(scope)) return bernard(scope);                       // BERNARD first — outranks the allowlist + JUDICIAL
	if (netOk(host)) return;
	const v = judicial({ kind: "net", scope, host, ...ctx() });
	if (v) return applyVerdict(v, scope);
	if (yes(await askAsync(`\n[broker] ⚠ ${scope} not allowed. Allow this run? [y/N] `))) return grant(scope);
	throw new Error(`[broker] DENIED ${scope}`);
}
export function gateFsSync(op, p) {
	const abs = String(p), scope = `fs:${op}:${abs}`;
	if (redline(scope)) return bernard(scope);
	if (fsOk(abs)) return;
	const v = judicial({ kind: "fs", op, scope, path: abs, ...ctx() });
	if (v) return applyVerdict(v, scope);
	if (yes(askSync(`\n[broker] ⚠ ${scope} not allowed. Allow this run? [y/N] `))) return grant(scope);
	throw new Error(`[broker] DENIED ${scope}`);
}
export function gateExecSync(cmd) {
	const b = String(cmd), scope = "exec:" + b;
	if (redline(scope)) return bernard(scope);
	if (execOk(b)) return;
	const v = judicial({ kind: "exec", scope, bin: b, ...ctx() });
	if (v) return applyVerdict(v, scope);
	if (yes(askSync(`\n[broker] ⚠ ${scope} not allowed. Allow this run? [y/N] `))) return grant(scope);
	throw new Error(`[broker] DENIED ${scope}`);
}

const realFetch = globalThis.fetch;
if (realFetch) globalThis.fetch = async function (input, init) {
	let host = "*"; try { host = new URL(typeof input === "string" ? input : input.url).host; } catch {}
	await gateNet(host); return realFetch.call(this, input, init);
};
process.stderr.write(`[broker] active — net:[${ALLOW.net.join(",") || "∅"}] fs:[${ALLOW.fs.join(",") || "∅"}] exec:[${ALLOW.exec.join(",") || "∅"}]  judiciary:[${process.env.JUDICIAL ? process.env.JUDICIAL : "TTY"}]  bernard:[armed]\n`);
