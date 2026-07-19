/** @jsxImportSource preact */
/**
 * VS Code workbench mounted full-size in an <iframe>.
 *
 * The workbench runs inside an <iframe> (its own document) so monaco taking over `document.body`
 * never touches the host page. The iframe loads `/__vscode__/host.html`, which runs the entry
 * (workbench.js).
 *
 * Files + saves cross the iframe boundary over postMessage (same origin): the entry signals "ready"
 * → we send it the workspace `files`/`openEditors`; it posts "save" back with the edited path +
 * contents, which we hand to `onSave`. The host app must only call this once `crossOriginIsolated`
 * is true (SharedArrayBuffer).
 *
 * Singleton — monaco-vscode-api is one global workbench; subsequent calls are no-ops.
 */
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import { css } from "./theme";

const iframeStyle = css({ "border": 0, "width": "100%", "height": "100%" });

export interface VscodeWindowOptions {
	/** Files to seed the workbench with. */
	"files"?: WorkbenchFile[];
	/** Files (by path) opened on first layout. */
	"openEditors"?: string[];
	/** Workspace folder the files live under (shown as the explorer root, e.g. "/repo"). */
	"workspaceFolder"?: string;
	/** Called in *this* document when a document is saved in the workbench. */
	"onSave"?: (path: string, contents: string) => void;
	/** Where to mount the workbench. Default: document.body. */
	"mountInto"?: HTMLElement;
}

/** Handle returned by createVscodeWindow for talking to the workbench after it's mounted. */
export interface VscodeWindowHandle {
	/** Resolves once the workbench has actually booted (monaco mounted), for readiness gating. */
	"whenReady": Promise<void>;
}

let booted = false;

export function createVscodeWindow(options: VscodeWindowOptions = {}): VscodeWindowHandle {
	if (booted) { return { "whenReady": Promise.resolve() }; }
	booted = true;

	let markReady: () => void;
	const whenReady = new Promise<void>((resolve) => { markReady = resolve; });

	const { files = [], openEditors = [], workspaceFolder, onSave, mountInto = document.body } = options;
	const base = (import.meta as unknown as { "env"?: { "BASE_URL"?: string } }).env?.BASE_URL ?? "/";

	const iframe = document.createElement("iframe");

	// Explicit host page (not the directory root): monaco's own dist/index.html is the webview
	// pre-page, so the workbench host ships as host.html alongside it.
	iframe.src = base + "__vscode__/host.html";
	iframe.className = iframeStyle();

	// Mount the workbench iframe full-viewport. `position: fixed; inset: 0` gives it definite dimensions
	// (resolved against the viewport) that the workbench can measure at boot — plain `height: 100%` is 0
	// until the ancestor chain lays out, which is what tripped monaco's "figure out width and height".
	const container = document.createElement("div");

	container.style.position = "fixed";
	container.style.inset = "0";
	mountInto.appendChild(container);
	container.appendChild(iframe);

	// Bridge to the workbench entry. Kept registered (not one-shot) so a detach/reload re-handshakes.
	// We reply to whoever handshook (`event.source`), so the same bridge serves the in-page iframe and
	// a popped-out tab alike.
	window.addEventListener("message", (event) => {
		const data = event.data as { "source"?: string; "type"?: string; "path"?: string; "contents"?: string } | null;

		if (data?.source !== "vscode") { return; }
		const target = event.source as Window;

		if (data.type === "ready") {
			target.postMessage({ "source": "vscode-host", "type": "init", "files": files, "openEditors": openEditors, "workspaceFolder": workspaceFolder }, "*");
		} else if (data.type === "save" && typeof data.path === "string" && typeof data.contents === "string") {
			onSave?.(data.path, data.contents);
		} else if (data.type === "online") {
			markReady();
		}
	});

	return { "whenReady": whenReady };
}
