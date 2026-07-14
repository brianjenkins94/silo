/** Spawn helpers for the Node integration suites: box a fixture (instrument.ts → node) or run it under
 *  the --import preload, returning { status, stdout, stderr }. NODE_OPTIONS is cleared so the harness's
 *  own flags don't leak into the boxed/preloaded child. */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const FIX = path.join(HERE, "fixtures");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const INSTRUMENT = path.join(ROOT, "enforcement/instrument.ts");
const PRELOAD = path.join(ROOT, "enforcement/preload.mjs");

const env = (e) => ({ ...process.env, "NODE_OPTIONS": "", ...e });

/** Bundle a fixture with the broker injected, then run the bundle. */
export function box(fixture, extraEnv = {}) {
	const src = path.join(FIX, fixture);
	const out = path.join(tmpdir(), `silo-test-${process.pid}-${Math.random().toString(36).slice(2)}.box.mjs`);
	const b = spawnSync(TSX, [INSTRUMENT, src, out], { "encoding": "utf8", "env": env() });

	if (b.status !== 0) { return { "status": b.status ?? 1, "stdout": b.stdout ?? "", "stderr": `[box build failed] ${b.stderr ?? ""}` }; }
	const r = spawnSync(process.execPath, [out], { "encoding": "utf8", "env": env(extraEnv) });

	rmSync(out, { "force": true });

	return { "status": r.status ?? 1, "stdout": r.stdout ?? "", "stderr": r.stderr ?? "" };
}

/** Run a fixture under `node --import preload.mjs`. */
export function preload(fixture, extraEnv = {}) {
	const r = spawnSync(process.execPath, ["--import", PRELOAD, path.join(FIX, fixture)], { "encoding": "utf8", "env": env(extraEnv) });

	return { "status": r.status ?? 1, "stdout": r.stdout ?? "", "stderr": r.stderr ?? "" };
}
