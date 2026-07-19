/**
 * The silo review kernel as a same-origin ESM module, built with oxc's `browser` build (wasm) by
 * core.config.ts → dist/core.js (+ its wasm/WASI-worker assets), served at /__vscode__/core.js.
 *
 * The CJS extension can't be ESM (the host guards `_loadESMModule`), but it CAN `await import()` this
 * at runtime — that path bypasses the guard (verified). So the extension dynamically imports this to run
 * silo's REAL `unitsOfSource`/`understoodOf` in-browser, closing the stopgap's monaco-symbol drift.
 */
export { understoodOf, unitsOfSource } from "../../../commands/review-core";
export type { ReviewStore, Understood, Unit } from "../../../commands/review-core";

// The deps-in-browser CAPABILITY path (esm.sh → webcrack → detect) — live `exposed` without the CLI.
export { capsOfPackage, exposedOfSource } from "../../../detect/caps-browser";
export type { FileCaps } from "../../../detect/caps-browser";
