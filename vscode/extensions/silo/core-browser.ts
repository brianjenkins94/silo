/**
 * The silo review kernel as a same-origin ESM module (core.js) — built by core.config.ts with oxc's browser
 * build (the current threaded @oxc-parser/binding-wasm32-wasi) + its wasm/WASI-worker assets, served at
 * /__vscode__/core.js. The WEB/harness path: the harness is crossOriginIsolated, so the threaded wasm + worker
 * run. The CJS extension can't be ESM but CAN `await import()` this at runtime (bypassing the host's ESM guard),
 * giving the overlay silo's REAL unitsOfSource/understoodOf/attributedTransforms — byte-identical to the CLI.
 * (This is exactly the provider.ts `Kernel` shape.)
 */
export { understoodOf, unitsOfSource } from "../../../commands/review-core";
export { attributedTransforms } from "../../../commands/session-core";
