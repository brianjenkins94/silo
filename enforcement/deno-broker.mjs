/**
 * PROTOTYPE — Deno permission-broker adapter: silo as the FULL owner of TOFU under Deno.
 *
 *   node enforcement/deno-broker.mjs /tmp/silo.sock        # start the broker (its own TTY = prompts work)
 *   DENO_PERMISSION_BROKER_PATH=/tmp/silo.sock deno run x  # Deno routes every permission check here
 *
 * Deno disables its flags + prompt and sends each check { v, pid, id, datetime, permission, value? };
 * we map it to a silo scope, run the decision pipeline (BERNARD redline → allowlist → JUDICIAL →
 * record drift), and reply { id, result:"allow"|"deny", reason? }. Deno still ENFORCES (its sandbox) —
 * we only DECIDE. NOTE: decision logic mirrors capability-broker.mjs; TODO extract a shared
 * enforcement/decide.mjs so both backends share one brain (avoid redline-list drift).
 * Coverage: Deno models read/write/net(host)/run/env/ffi/sys — eval is NOT a Deno permission, so it
 * never reaches here; gating eval under Deno still needs an in-runtime shim (see notes).
 */
import { existsSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { judicial, redline } from "./decide.mjs";

const SOCK = process.argv[2] || process.env.DENO_PERMISSION_BROKER_PATH;

if (!SOCK) { console.error("usage: deno-broker <socket-path> (or set DENO_PERMISSION_BROKER_PATH)"); process.exit(2); }
const GRANTS = process.env.DENO_GRANTS || ".silo/deno-grants.json";

// Deno permission name → silo scope kind. value = path / host[:port] / command / VAR.
const KIND = { "read": "fs:read", "write": "fs:write", "net": "net", "run": "exec", "env": "env", "sys": "sys", "ffi": "ffi", "import": "net" };

function scopeOf(r) {
	const k = KIND[r.permission] || r.permission;

	return r.value != null && r.value !== "" ? `${k}:${r.value}` : k;
}

// redline() + judicial() come from the shared decide.mjs core (same brain as the Node broker).

const granted = new Set(existsSync(GRANTS) ? JSON.parse(readFileSync(GRANTS, "utf8")) : []);

function persist() { try { writeFileSync(GRANTS, JSON.stringify([...granted], null, 0)); } catch {} }

function bernard(scope) {   // one-time human break-glass on the broker's OWN tty; fails closed headless
	if (!process.stdin.isTTY) { return { "result": "deny", "reason": "BERNARD redline, no human present (fail-closed)" }; }
	const tok = Math.random().toString(36).slice(2, 8).toUpperCase();

	process.stderr.write(`\n⛔ [BERNARD] REDLINE ${scope} — type ${tok} to authorize: `);
	const buf = Buffer.alloc(64); let n = 0;

	try { n = readSync(0, buf, 0, 64, null); } catch {}

	return buf.toString("utf8", 0, n).trim().toUpperCase() === tok ? { "result": "allow" } : { "result": "deny", "reason": "BERNARD challenge failed" };
}

function decide(req) {
	const scope = scopeOf(req);

	if (granted.has(scope)) { return { "result": "allow" }; }                       // allowlist (already approved)
	let out;

	if (redline(scope)) { out = bernard(scope); }                                 // BERNARD outranks JUDICIAL
	else {
		const v = judicial({ ...req, "scope": scope });

		out = !v ? { "result": "deny", "reason": "no JUDICIAL decider (interactive ask unsupported over socket)" } : v.behavior === "allow" ? { "result": "allow" } : { "result": "deny", "reason": v.message };
	}

	if (out.result === "allow") {
		const isNew = !granted.has(scope);

		granted.add(scope); persist(); process.stderr.write(`[deno-broker] ${isNew ? "+ new " : ""}allow ${scope}\n`);
	} else { process.stderr.write(`[deno-broker] deny ${scope} — ${out.reason}\n`); }

	return out;
}

const server = net.createServer((conn) => {
	let buf = "";

	conn.on("data", (d) => {
		buf += d.toString();
		let i;

		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();

			buf = buf.slice(i + 1);
			if (!line) { continue; }
			let req;

			try { req = JSON.parse(line); } catch { continue; }
			conn.write(JSON.stringify({ "id": req.id, ...decide(req) }) + "\n");
		}
	});
});

try { unlinkSync(SOCK); } catch {}
server.listen(SOCK, () => process.stderr.write(`[deno-broker] listening ${SOCK}  judiciary:[${process.env.JUDICIAL || "ask"}] bernard:[armed]\n`));
