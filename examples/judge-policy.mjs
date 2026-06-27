/**
 * Example JUDICIAL judge — a declarative policy (the simplest decider). Reads the broker's request
 * JSON on stdin and prints a verdict mirroring the Agent SDK's PermissionResult:
 *   { behavior: "allow", scope?, persist? }  |  { behavior: "deny", message }
 *
 *   JUDICIAL="node runner/judges/policy.mjs" silo <script>
 *
 * Swap this for an AI judge (call an LLM with the request + r.confidence/r.script context) or a
 * tiered judge (policy → AI → human). It runs in the parent/trusted context, never inside the box.
 */
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(0, "utf8") || "{}");

function decide(r) {
	if (r.kind === "fs" && r.op === "read") return { behavior: "allow" };
	if (r.kind === "fs" && r.op === "write")
		return /^\/(private\/)?tmp\//.test(r.path || "")
			? { behavior: "allow" }
			: { behavior: "deny", message: `fs:write outside /tmp denied: ${r.path}` };
	if (r.kind === "net" && /(^|\.)localhost$/.test((r.host || "").split(":")[0]))
		return { behavior: "allow", persist: true };
	if (r.kind === "exec") return { behavior: "deny", message: `exec not permitted: ${r.bin}` };
	return { behavior: "deny", message: `no policy rule for ${r.scope}` };
}

process.stdout.write(JSON.stringify(decide(r)));
