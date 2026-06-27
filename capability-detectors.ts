/**
 * PROTOTYPE — capability detectors. PURE (no node builtins) so it runs unchanged in node AND the
 * browser — the shared core of the platform-split (CLI raw+DCE / browser esm.sh+webcrack).
 *
 * Run over un-minified / deobfuscated code: import-based detectors survive minification; call-based
 * give fs:read/write granularity. Caller deobfuscates first (webcrack/wakaru) so these fire on
 * direct calls rather than through thunks.
 */
const imp = (m: string) => new RegExp(`from\\s*["']node:${m}["']|require\\(\\s*["'](?:node:)?${m}["']\\s*\\)`);

export const DETECTORS: [RegExp, string][] = [
	[imp("child_process"), "exec"],
	[/\b(spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(/, "exec"],   // call-based (deobfuscated/bare)
	[imp("(net|http|https|tls|dgram|http2)"), "net"],
	[/\bfetch\s*\(|\bnew WebSocket\b/, "net"],
	[/\beval\s*\(|new Function\s*\(/, "eval"],
	[/\bprocess\.env\b/, "env"],
	[/\b(writeFileSync|writeFile|createWriteStream|mkdirSync|mkdir|unlinkSync|unlink|rmSync|renameSync|appendFileSync)\s*\(/, "fs:write"],
	[/\b(readFileSync|readFile|createReadStream|readdirSync|readdir|existsSync|statSync)\s*\(/, "fs:read"],
	[imp("fs"), "fs"],   // coarse — dropped by refine() if read/write seen
];

export function detect(code: string): string[] {
	return refine(DETECTORS.filter(([re]) => re.test(code)).map(([, c]) => c));
}

/** Drop the indeterminate marker and the coarse `fs` when a granular fs:read/write is present. */
export function refine(caps: Iterable<string>): string[] {
	const s = new Set(caps); s.delete("?");
	if (s.has("fs:read") || s.has("fs:write")) s.delete("fs");
	return [...s].sort();
}
