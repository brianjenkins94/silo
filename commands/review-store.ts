/**
 * The PURE review-store record/format + the ratchet gate rule — the bits the CLI and the browser overlay
 * must agree on byte-for-byte. Kept separate from review-core (which imports oxc/node:crypto) so the CJS
 * browser overlay can import these without pulling in the parser.
 *
 * If the store format or the gate rule ever changes, it changes HERE, once — both silo and the extension
 * follow.
 */
import type { ReviewRecord, ReviewStore, Understood } from "./review-core";

/** A review-store record for a unit signed off at `hash` (waived = accepted without reading). `fp` = the
 *  per-statement fingerprints captured at review time (see review-core `fingerprintsOfSource`) — lets a later
 *  re-review locate exactly what changed. */
export function reviewRecord(hash: string, waived = false, fp?: readonly [string, string][]): ReviewRecord {
	return { "hash": hash, "at": new Date().toISOString(), ...(waived ? { "waived": true } : {}), ...(fp && fp.length ? { "fp": fp as [string, string][] } : {}) };
}

/** `.silo/review.json` on disk: valid JSON, but written **sorted by unit id, one record per line** — so two
 *  branches editing DIFFERENT units touch different lines and git auto-merges them (no conflict). Only two
 *  people reviewing the SAME unit collide, and that resolves trivially (keep the hash matching merged source). */
export function serializeStore(store: ReviewStore): string {
	const ids = Object.keys(store).sort();

	if (ids.length === 0) { return "{}\n"; }

	return "{\n" + ids.map((id) => `${JSON.stringify(id)}: ${JSON.stringify(store[id])}`).join(",\n") + "\n}\n";
}

/** THE ratchet gate: a unit is gated when it's capability-bearing (`exposed`) AND changed by this diff
 *  (`touched`) AND not yet read (`understood` is unreviewed/stale — i.e. neither reviewed nor waived). */
export function isGated(exposed: boolean, touched: boolean, understood: Understood): boolean {
	return exposed && touched && understood !== "reviewed" && understood !== "waived";
}
