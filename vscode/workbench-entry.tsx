/** @jsxImportSource preact */
/**
 * Iframe entry — runs *inside* the workbench iframe (served at /__vscode__/host.html).
 *
 * Renders the <Workbench/> shell, then boots monaco into the resolved part containers once the host
 * page has sent the workspace (files/openEditors) over postMessage. On save, it posts the edited
 * path + contents back to the host. `boot`/`registerExtension` come from the pre-built
 * monaco-vscode-api bundle, kept external and mapped to the sibling `./main.js`.
 */
import type { WorkbenchFile, WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";
import { boot, ExtensionHostKind, registerExtension } from "@brianjenkins94/monaco-vscode-api/main";
import { render } from "preact";
// The silo extension: its package.json manifest + its bundled CJS code (from the `silo:extension` virtual
// module in entry.config.ts). At runtime the extension `import()`s the served oxc-wasm core (see provider-core).
import siloExtensionCode from "silo:extension";
import siloManifest from "./extensions/silo/package.json";
import { registerBurndownView } from "./burndown-view";
import { Workbench } from "./Workbench";
import { configuration, keybindings } from "./workspace";

interface Init { "files": WorkbenchFile[]; "openEditors": string[]; "workspaceFolder"?: string }

// The host page we report to: our parent when nested in its iframe (in-page window), or our opener
// when we've been popped out into our own standalone tab/window.
const host = window.opener ?? window.parent;

let parts: WorkbenchParts | undefined;
let init: Init | undefined;
let booted = false;

// The per-extension VS Code API, captured once the default extension resolves. The custom activity
// bar drives the workbench through it (view-switch commands); `runCommand` reads the latest api so
// the bar — rendered before boot — works on clicks made after boot.
// eslint-disable-next-line ts/no-explicit-any
let vscodeApi: any = null;

// The burndown lives in the auxiliary bar as a custom view (real DOM, not a webview). Registered at module
// load (before boot, like the demo's custom views); it fetches its model over the command bridge once the
// extension API resolves below.
// eslint-disable-next-line ts/no-explicit-any
let resolveApi: (api: any) => void = () => {};
// eslint-disable-next-line ts/no-explicit-any
const apiReady = new Promise<any>((resolve) => { resolveApi = resolve; });

registerBurndownView(() => apiReady);

function runCommand(command: string): void { void vscodeApi?.commands?.executeCommand(command); }

function maybeBoot(): void {
	if (booted || parts === undefined || init === undefined) { return; }
	booted = true;
	const { files, openEditors, workspaceFolder } = init;

	boot({
		"parts": parts,
		"files": files,
		"openEditors": openEditors,
		"workspaceFolder": workspaceFolder,
		"configuration": configuration,
		"keybindings": keybindings,
		"onSave": (path, contents) => {
			host.postMessage({ "source": "vscode", "type": "save", "path": path, "contents": contents }, "*");
		}
	})
		.then(() => {
			// The silo extension — the default API context (so getApi()/runCommand work) + the review overlay.
			// Registered as CJS via a data: URL; it `import()`s the served oxc-wasm core at runtime.
			const ext = registerExtension(siloManifest, ExtensionHostKind.LocalProcess);

			ext.registerFileUrl("./extension.js", "data:text/javascript;base64," + window.btoa(siloExtensionCode));
			ext.setAsDefaultApi();
			ext.getApi().then((api) => {
				vscodeApi = api;
				resolveApi(api);   // unblock the burndown view's command bridge
				// Boot into the Explorer viewlet (matching the activity bar's default). Deferred so it runs
				// AFTER the workbench restores its last-active viewlet (which would otherwise win).
				setTimeout(runCommand, 0, "workbench.view.explorer");
				// Reveal the burndown in the auxiliary bar (doesn't disturb the primary sidebar/Explorer).
				setTimeout(runCommand, 150, "silo.burndown.focus");
			}).catch((e) => { console.error("[vscode] default extension setup failed", e); });

			// Tell the host the workbench is up (readiness gating).
			host.postMessage({ "source": "vscode", "type": "online" }, "*");
		})
		.catch((error) => {
			console.error("[vscode] workbench boot failed", error);
		});
}

window.addEventListener("message", (event) => {
	if (event.source !== host) { return; }
	const data = event.data as { "source"?: string; "type"?: string } & Partial<Init> | null;

	if (data?.source === "vscode-host" && data.type === "init") {
		init = { "files": data.files ?? [], "openEditors": data.openEditors ?? [], "workspaceFolder": data.workspaceFolder };
		maybeBoot();
	}
});

render(<Workbench onReady={(resolved) => { parts = resolved; maybeBoot(); }} runCommand={runCommand} />, document.body);

// Tell the host we're ready to receive the workspace.
host.postMessage({ "source": "vscode", "type": "ready" }, "*");
