/**
 * The capability-fingerprint cache. A fingerprint is IMMUTABLE for its key — `pkg@version` (whole
 * package) or `…|members|dynamic` (consumer slice) can each mean exactly one thing — so it caches
 * perfectly. Derived data → gitignored (a committed aggregate merges wrong; CI caches the `.silo` dir).
 */
import * as fs from "@brianjenkins94/util/fs";
import { ensureSiloDir, FINGERPRINTS } from "./paths.js";

const fingerprints: Record<string, string[]> = fs.existsSync(FINGERPRINTS) ? JSON.parse(fs.readFileSync(FINGERPRINTS)) : {};
let dirty = false;

/** Memoize a fingerprint under an IMMUTABLE key. An `undefined` key = not stably identifiable (unknown
 *  version) → recompute rather than cache under a lie. */
export async function fingerprint(key: string | undefined, compute: () => Promise<string[]>): Promise<string[]> {
	if (key !== undefined && fingerprints[key] !== undefined) { return fingerprints[key]; }

	const caps = await compute();

	if (key !== undefined) { fingerprints[key] = caps; dirty = true; }

	return caps;
}

/** Persist once, after a run's audits have all fed the cache. */
export async function flushFingerprints(): Promise<void> {
	if (dirty) { await ensureSiloDir(); fs.writeFileSync(FINGERPRINTS, JSON.stringify(fingerprints, null, 2) + "\n"); dirty = false; }
}
