/**
 * PROTOTYPE — Deno eval/Function shim (Deno has no `--import` preload, so this is a WRAPPER ENTRY).
 *
 *   DENO_PERMISSION_BROKER_PATH=/tmp/silo.sock deno run enforce/silo-deno.mjs <target> [args]
 *
 * Two-layer enforcement under Deno:
 *   • native caps (read/write/net/run/env) — Deno's sandbox enforces, routed to enforce/deno-broker.mjs
 *   • dynamic codegen — eval, new Function, AND the hidden AsyncFunction / GeneratorFunction /
 *     AsyncGeneratorFunction constructors (reachable via (async()=>{}).constructor) — is NOT a Deno
 *     permission, so it never reaches the broker. This wrapper gates every codegen entry point through
 *     the SAME decide.mjs core, THEN imports the target. eval is on BERNARD's redline (/^eval\b/) → no
 *     decider may auto-approve; with no in-shim TTY it fails CLOSED.
 *
 * Trade-off: this gates EVERY codegen call (incl. library use), so it is deliberately blunt — the model
 * is "dynamic codegen is redline under Deno unless a human breaks glass".
 */
import { installCodegenGate } from "./codegen-gate.mjs";
import { judicial, redline } from "./decide.mjs";

// All codegen entry points (eval / Function / AsyncFunction / Generator*) route through here.
installCodegenGate((scope) => {
	if (redline(scope)) { throw new Error(`[silo] ⛔ BERNARD redline ${scope} — dynamic codegen, no in-shim human → denied`); }
	const v = judicial({ "kind": "eval", "scope": scope });

	if (!v) { throw new Error(`[silo] eval blocked ${scope} — no JUDICIAL decider`); }
	if (v.behavior !== "allow") { throw new Error(`[silo] eval denied ${scope} — ${v.message}`); }
});

const target = Deno.args[0];

if (!target) { console.error("usage: deno run enforce/silo-deno.mjs <target> [args]"); Deno.exit(2); }
const href = target.startsWith("/") || target.includes("://")
	? (target.includes("://") ? target : "file://" + target)
	: new URL(target, "file://" + Deno.cwd() + "/").href;

process.stderr.write(`[silo-deno] eval/Function gated (decide.mjs) → ${target}\n`);
await import(href);
