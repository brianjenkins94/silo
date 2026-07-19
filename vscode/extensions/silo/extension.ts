/**
 * silo extension entry (CJS — today's web-worker extension host). The overlay runs on silo's REAL review
 * kernel: the CJS host can't load ESM as an extension, but coreProvider `await import()`s the served
 * oxc-wasm core at runtime (bypassing the ESM-entry guard) — so `understood`/`stale` match the CLI exactly.
 *
 * Bundled to a browser CommonJS module at build time (see vscode/entry.config.ts).
 */
import type * as vscode from "vscode";
import { activateOverlay } from "./overlay";
import { coreProvider } from "./provider-core";

export function activate(context: vscode.ExtensionContext): Promise<void> {
	return activateOverlay(context, coreProvider());
}

export function deactivate(): void { /* decorations are disposed via context.subscriptions */ }
