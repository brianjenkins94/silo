/**
 * Default workbench settings. Files come from the host over postMessage, so only the editor
 * settings/keybindings live here.
 */

/** VS Code user settings (settings.json), passed to `boot({ configuration })`. */
export const configuration: Record<string, unknown> = {
	"workbench.colorTheme": "Default Dark+",
	"workbench.iconTheme": "vs-seti",
	"editor.fontSize": 12,
	"editor.semanticHighlighting.enabled": true,
	"editor.bracketPairColorization.enabled": false,
	"editor.scrollBeyondLastLine": true,
	"editor.mouseWheelZoom": true,
	"files.autoSave": "off",
	"workbench.sideBar.location": "left",
	// Keep node_modules out of the explorer/search (a UI filter — doesn't affect module resolution).
	"files.exclude": { "**/node_modules": true }
};

/** Keybindings (keybindings.json), passed to `boot({ keybindings })`. */
export const keybindings: unknown[] = [
	{ "key": "ctrl+d", "command": "editor.action.deleteLines", "when": "editorTextFocus" }
];
