/**
 * silo extension entry — the WEB / harness build. The overlay runs on silo's REAL review kernel via the served
 * oxc-wasm core: coreProvider `await import()`s /__vscode__/core.js (the current threaded binding-wasm32-wasi,
 * which runs because the harness is crossOriginIsolated). Bundled to a browser CJS module (see entry.config.ts).
 * The shipped desktop extension is extension-node.ts (Node host, native oxc-parser).
 */
import type * as vscode from "vscode";
import { activateOverlay } from "./overlay";
import { coreProvider } from "./provider-core";

export function activate(context: vscode.ExtensionContext): Promise<void> {
	return activateOverlay(context, coreProvider());
}

export function deactivate(): void { /* decorations are disposed via context.subscriptions */ }
