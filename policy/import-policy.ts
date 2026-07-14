/**
 * PROTOTYPE — import policy. A denylist of module specifiers, each with an optional replacement and
 * reason. Distinct from capability analysis: this governs what a module may *depend on* (use my fs
 * wrapper, not node:fs; never left-pad), not what it can *do*.
 *
 * Direct imports only for now; transitive (supply-chain "no left-pad *anywhere*") is the extension —
 * the vite-DCE bundle already exposes the transitive external import set, so that plugs in later.
 */

export interface ImportPolicy {
	"prohibited": Record<string, { "use"?: string; "reason"?: string }>;
}

export interface Violation { "specifier": string; "use"?: string; "reason"?: string }

/** Every module specifier the source imports — static, dynamic, side-effect, and require(). */
export function extractImports(src: string): string[] {
	const out = new Set<string>();
	const add = (re: RegExp) => { for (const m of src.matchAll(re)) { out.add(m[1]); } };

	add(/import\s[^"';]*?from\s*["']([^"']+)["']/gu);   // import … from "x"
	add(/import\s*["']([^"']+)["']/gu);                   // import "x" (side-effect)
	add(/import\s*\(\s*["']([^"']+)["']\s*\)/gu);         // import("x")
	add(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu);      // require("x")

	return [...out];
}

export function checkImports(imports: string[], policy: ImportPolicy): Violation[] {
	return imports.filter((i) => i in policy.prohibited).map((i) => ({ "specifier": i, ...policy.prohibited[i] }));
}

// Run directly: print a file's imports + any policy violations.
if (import.meta.url === `file://${process.argv[1]}`) {
	const { readFileSync } = await import("node:fs");
	const file = process.argv[2] ?? "cli.ts";
	const policy: ImportPolicy = {
		"prohibited": {
			"left-pad": { "reason": "banned — use String.prototype.padStart" }
		}
	};
	const imports = extractImports(readFileSync(file, "utf8"));

	console.log(`${file}\n  imports: ${imports.join(", ") || "(none)"}`);
	const v = checkImports(imports, policy);

	console.log(v.length ? "\n  POLICY VIOLATIONS:" : "\n  policy: clean");
	for (const x of v) { console.log(`    ✗ ${x.specifier}${x.use ? `  → use ${x.use}` : ""}${x.reason ? `  (${x.reason})` : ""}`); }
}
