/**
 * The PURE review-store record/format + the ratchet gate rule — the bits the CLI and the browser overlay
 * must agree on byte-for-byte. Kept separate from review-core (which imports oxc/node:crypto) so the CJS
 * browser overlay can import these without pulling in the parser.
 *
 * If the store format or the gate rule ever changes, it changes HERE, once — both silo and the extension
 * follow.
 */
import type { ReviewRecord, ReviewStore, Understood } from "./review-core";

/** A review-store record for a unit signed off at `hash` (waived = accepted without reading). */
export function reviewRecord(hash: string, waived = false): ReviewRecord {
	return { "hash": hash, "at": new Date().toISOString(), ...(waived ? { "waived": true } : {}) };
}

/** `.silo/review.json` on disk: 2-space JSON + trailing newline. */
export function serializeStore(store: ReviewStore): string {
	return JSON.stringify(store, undefined, 2) + "\n";
}

/** THE ratchet gate: a unit is gated when it's capability-bearing (`exposed`) AND changed by this diff
 *  (`touched`) AND not yet read (`understood` is unreviewed/stale — i.e. neither reviewed nor waived). */
export function isGated(exposed: boolean, touched: boolean, understood: Understood): boolean {
	return exposed && touched && understood !== "reviewed" && understood !== "waived";
}
