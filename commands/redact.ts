/**
 * Deterministic, conservative secret-redaction applied at the persistence boundary before a session transform
 * is written — egress is the trust boundary for the corpus. Over-redacts on purpose (a false positive loses a
 * constant; a false negative leaks a secret). No deps, so the extension can import it without pulling the parser.
 * Not a keylog scrubber — the raw edit stream never persists at all; this only guards what does.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|pk|rk|ghp|gho|xox[abprs])[-_][A-Za-z0-9]{16,}\b/gu,   // common key prefixes (stripe/github/slack/…)
	/\b[A-Fa-f0-9]{32,}\b/gu,                                       // long hex — tokens/hashes used as secrets
	/(["'`])[A-Za-z0-9+/]{40,}={0,2}\1/gu                           // long base64-ish string literals
];

export function redactSecrets(source: string): string {
	let out = source;

	for (const pattern of SECRET_PATTERNS) { out = out.replace(pattern, "«redacted»"); }

	return out;
}
