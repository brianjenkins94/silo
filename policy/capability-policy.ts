/**
 * Capability policy — which capabilities are dangerous enough to gate on, and (later) which RESOURCES
 * are never grantable at all.
 *
 * Sibling to import-policy.ts. Lives here, not in cli.ts, so the gate is configuration rather than a
 * hardcoded opinion buried in the command.
 */

/** Capabilities that make a file worth reviewing. The trust ratchet counts UNREVIEWED units in files
 *  reaching any of these — not all unreviewed code, only the code that can actually hurt you. */
export const DANGEROUS = new Set(["exec", "eval", "net", "fs:write"]);

/**
 * `?` (unanalyzable) IS dangerous — "unknown is untrusted" is silo's whole thesis; a package doesn't earn
 * a pass by being opaque.
 *
 * This was off until the analyzer stopped manufacturing false `?`s of its own: the DCE probe imported a
 * package's BARE NAME, which is unresolvable for a subpath-only package (no `.` export — @brianjenkins94/util),
 * and a whole-package probe was all-or-nothing, so ONE unresolvable entry (an uninstalled optional peer like
 * playwright) collapsed all 46 entries to `?`. Both fixed — the probe now uses the real specifier and fans
 * out per-entry, unioning what resolves. With false `?`s gone, gating on the real ones is meaningful.
 */
export const TREAT_UNKNOWN_AS_DANGEROUS = true;

export function isDangerous(cap: string): boolean {
	return DANGEROUS.has(cap) || (TREAT_UNKNOWN_AS_DANGEROUS && cap === "?");
}
