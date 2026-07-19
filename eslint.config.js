import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	// `**/` so NESTED build output is ignored too (vscode/dist, vscode/dist-ext) — otherwise eslint lints the
	// minified bundles + inlined billboard/wasm and emits >64MB of JSON, which broke `review --json` (lint pass).
	{ "ignores": ["**/docs/**", "**/dist/**", "**/dist-ext/**", "test/deno/**"] }
];
