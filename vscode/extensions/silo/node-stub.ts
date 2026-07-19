/**
 * Empty stub for node modules webcrack references but never REACHES in the browser.
 *
 * webcrack picks its sandbox at runtime — `isBrowser() ? createBrowserSandbox() : createNodeSandbox()` — and
 * only the Node path touches `node:fs/promises` (for `.save()`) and `isolated-vm` (string-array execution). In
 * the browser those branches are dead, but the bundler still resolves the static import specifiers and chokes on
 * the native `isolated-vm` / node builtins. Aliasing them to this no-op module satisfies resolution; the code is
 * never called. (Mirrors webcrack's own netlify-playground vite config.)
 */
export default {};
export const promises = {};
export const readFile = () => { throw new Error("node-stub: not available in the browser"); };
export const writeFile = () => { throw new Error("node-stub: not available in the browser"); };
