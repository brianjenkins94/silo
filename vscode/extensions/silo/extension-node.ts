/**
 * silo extension entry — the SHIPPED desktop build (Node extension host). The overlay runs on silo's REAL review
 * kernel imported directly on native oxc-parser (nativeProvider) — byte-identical to the CLI, no wasm/worker/SAB.
 * Bundled by package-vsix.ts (esbuild platform:node, oxc-parser shipped as node_modules). The web harness entry
 * is extension.ts (served oxc-wasm core).
 */
import type * as vscode from "vscode";
import { activateOverlay } from "./overlay";
import { nativeProvider } from "./provider-native";

export function activate(context: vscode.ExtensionContext): Promise<void> {
	return activateOverlay(context, nativeProvider());
}

export function deactivate(): void { /* decorations are disposed via context.subscriptions */ }
