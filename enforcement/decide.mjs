/**
 * Shared DECISION CORE for every enforcement backend (the in-process broker, the --import preload,
 * and the Deno permission-broker). One brain so the redline list + JUDICIAL contract can't drift.
 *
 *   redline(scope)  — is this scope on BERNARD's catastrophic list? (conservative; over-flag = safe)
 *   judicial(req)   — the JUDICIAL decider: null (unset/"ask" → caller's fallback) | { behavior, scope?, message? }
 *
 * bernard's human break-glass challenge + the allowlist *source* stay per-backend (each owns its TTY
 * and its grant store). spawnSync via createRequire so the box's node:child_process rewrite can't gate it.
 */
import { createRequire } from "node:module";

const REDLINE = [
	/^fs:write:.*\/\.(ssh|aws|gnupg|npmrc|netrc)\b/,                  // credentials
	/^fs:write:.*\/\.git\//,                                          // git internals
	/^fs:write:\/(etc|bin|sbin|usr|boot|dev|System|Library)\//,       // system dirs
	/^exec:.*(dd|mkfs|fdisk|shutdown|reboot|halt|sh|bash|zsh|curl|wget|nc|ncat|rm)(\.\w+)?$/, // dangerous bins
	/^net:\*/,                                                        // indeterminate host
	/^eval\b/,                                                        // dynamic code
	...(process.env.BERNARD ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s))
];

export const redline = (scope) => REDLINE.some((re) => re.test(scope));

export function judicial(req) {
	const J = process.env.JUDICIAL;

	if (!J || J === "ask") { return null; }                              // caller falls back (TTY prompt, or deny)
	if (J === "allow") { return { "behavior": "allow" }; }
	if (J === "deny") { return { "behavior": "deny", "message": "JUDICIAL=deny" }; }
	try {
		const { spawnSync } = createRequire(import.meta.url)("node:child_process"); // lazy: only when a command judge runs
		const r = spawnSync(J, { "input": JSON.stringify(req), "encoding": "utf8", "shell": true });
		const v = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}");

		return v.behavior ? v : { "behavior": "deny", "message": "JUDICIAL: no verdict" };
	} catch (e) {
		return { "behavior": "deny", "message": "JUDICIAL error (fail closed): " + e.message };
	}
}
