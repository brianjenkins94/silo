/**
 * The CAPABILITY axis — the two-sided supply-chain audit that backs bare `silo` (the two-sided baseline):
 *   • auditConsumer — your OWN code: which members of each dep you import + what that reaches, per
 *     workspace, joined with provenance + review state (the two-axis marker).
 *   • auditPackages — your NODE_MODULES: each direct dependency's whole-package fingerprint, catching
 *     drift even in deps your code never imports (install/import-time payloads).
 * Both diff against the committed baseline and return a drift count; the caller gates on it.
 */
import type { SurfaceEntry } from "../detect/import-surface.js";
import type { Verdict } from "../shared/provenance.js";
import { baseRef, fileStates, gateUnits, reviewStates, touchedUnits, type Understood, type UnitState } from "./review.js";
import * as fs from "@brianjenkins94/util/fs";
import * as path from "node:path";
import { classify, workspaceImporters, workspaceSurfaces } from "../detect/import-surface.js";
import { builtinCaps, capsOf, wholePackageCaps } from "../detect/package-capabilities.js";
import { analyzeFile, gitCoauthoredFiles } from "../shared/provenance.js";
import { fingerprint, flushFingerprints } from "../shared/cache.js";
import { BASELINE, ensureSiloDir, PROJECT } from "../shared/paths.js";
import { isDangerous } from "../policy/capability-policy.js";

interface DepEntry { "kind": string; "version"?: string; "members": string[]; "dynamic": boolean; "caps": string[] }
type WsConsumer = Record<string, DepEntry>;   // spec → dep, for one workspace
interface PkgEntry { "version"?: string; "caps": string[] }
export interface Baseline { "consumer": Record<string, WsConsumer>; "packages": Record<string, PkgEntry> }

export const loadBaseline = (): Baseline => ({ "consumer": {}, "packages": {}, ...(fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE)) : {}) });

export async function saveBaseline(b: Baseline): Promise<void> { await ensureSiloDir(); fs.writeFileSync(BASELINE, JSON.stringify(b, null, 2) + "\n"); }

/** OWN CODE: which members of each dep your code imports/uses + what that reaches — partitioned by
 *  workspace (nearest package.json), so a monorepo attributes drift to the package that changed.
 *  Mutates b.consumer, and fills `exposed` with files reaching a dangerous capability. */
export async function auditConsumer(b: Baseline, target: string, review: Map<string, Understood>, exposed: Set<string>): Promise<number> {
	const surfaces = await workspaceSurfaces(path.resolve(target), PROJECT);
	const importers = await workspaceImporters(path.resolve(target), PROJECT);   // ws → spec → files that import it
	const prev = b.consumer; const
		next: Record<string, WsConsumer> = {};
	let drift = 0;
	// Provenance is orthogonal to capability: when a capability CHANGE is introduced by likely-AI code,
	// the audit marks it (review-prioritization signal — never changes pass/fail here). Memoized per file.
	const gitAI = gitCoauthoredFiles(PROJECT);   // files touched by an AI-co-authored commit (high-confidence)
	const provCache = new Map<string, Verdict>();
	const verdictFor = (rel: string): Verdict => {
		if (!provCache.has(rel)) {
			if (gitAI.has(path.resolve(rel))) { provCache.set(rel, "likely"); } else { try { provCache.set(rel, analyzeFile(path.resolve(rel)).verdict); } catch { provCache.set(rel, "clean"); } }
		}

		return provCache.get(rel);
	};

	const aiIntroduced = (ws: string, spec: string): boolean => (importers[ws]?.[spec] ?? []).some((f) => verdictFor(f) === "likely");
	// Where the TWO AXES JOIN: an AI-introduced capability expansion in code you have NOT reviewed is the
	// sharp signal; the same expansion in code you've read is a far weaker one. Worst state among the
	// introducing files wins. (Quality never changes pass/fail here — same rule as provenance.)
	const rank: Record<Understood, number> = { "unreviewed": 3, "stale": 2, "waived": 1, "reviewed": 0 };
	const reviewState = (ws: string, spec: string): Understood => (importers[ws]?.[spec] ?? [])
		.map((f) => review.get(path.relative(PROJECT, path.resolve(f))) ?? "unreviewed")
		.reduce((worst, s) => (rank[s] > rank[worst] ? s : worst), "reviewed" as Understood);
	let aiChanges = 0;
	// Caps depend on the FULL specifier + member slice — memoize so two workspaces using the same slice cost
	// one call. NOTE the specifier, not `c.pkg`: `classify` strips the subpath (`@scope/pkg/sub` → `@scope/pkg`),
	// but the DCE probe must import the SUBPATH the code actually uses (bare-name probes fail for subpath-only
	// packages). Keying on the specifier also stops `pkg/cmd` and `pkg/fs` (different caps!) from colliding.
	const capCache = new Map<string, Promise<string[]>>();
	const capsFor = (spec: string, use: SurfaceEntry, c: ReturnType<typeof classify>, fromDir: string) => {
		const key = `${c.kind}|${spec}|${c.version ?? ""}|${[...use.members].sort().join(",")}|${use.dynamic}`;

		if (!capCache.has(key)) {
			// builtins are a pure table lookup — no bundling, nothing to persist. Packages go through the
			// on-disk fingerprint cache: a slice is immutable for (spec@version, members, dynamic).
			capCache.set(key, c.kind === "builtin"
				? Promise.resolve(builtinCaps(spec, use.members, use.dynamic))
				: fingerprint(c.version === undefined ? undefined : key, () => capsOf(spec, [...use.members, ...(use.dynamic ? ["*"] : [])], fromDir, PROJECT)));
		}

		return capCache.get(key);
	};

	const wss = Object.keys(surfaces).sort();

	console.log(`  own code — ${wss.length} workspace(s)`);
	for (const ws of wss) {
		const wsDir = path.join(PROJECT, ws);   // resolve this workspace's deps local-first, then hoisted root
		const tracked = Object.entries(surfaces[ws])
			.map(([spec, use]) => ({ "spec": spec, "use": use, "c": classify(spec, wsDir, PROJECT) }))
			.filter((r) => r.c.kind !== "local")
			.sort((a, c) => a.spec.localeCompare(c.spec));

		if (!tracked.length) { continue; }
		const pws = prev[ws] ?? {};
		const cur: WsConsumer = next[ws] = {};

		console.log(`    [${ws}]  ${tracked.length} imported dependencies`);
		const width = Math.max(10, ...tracked.map((r) => (r.c.pkg ?? r.spec).length + (r.c.version?.length ?? 0) + 1));

		for (const { spec, use, c } of tracked) {
			const label = c.kind === "package" ? `${c.pkg}@${c.version ?? "?"}` : spec;
			const caps = await capsFor(spec, use, c, wsDir);

			cur[spec] = { "kind": c.kind, "version": c.version, "members": use.members, "dynamic": use.dynamic, "caps": caps };
			// Every file importing a dep that reaches a dangerous capability is "capability-bearing" — the
			// population the trust ratchet measures. Unreviewed code in these files is what actually matters.
			if (caps.some(isDangerous)) {
				for (const f of importers[ws]?.[spec] ?? []) { exposed.add(path.relative(PROJECT, path.resolve(f))); }
			}

			const p = pws[spec]; let mark = "";

			if (!p) { mark = "+ new"; drift++; } else {
				const gM = use.members.filter((m) => !p.members.includes(m));
				const gC = caps.filter((x) => !(p.caps ?? []).includes(x));
				const newDyn = use.dynamic && !p.dynamic;

				if (gC.length || gM.length || newDyn) { mark = "↑ " + [gC.length ? `+cap ${gC.join(",")}` : "", gM.length ? `+${gM.join(",")}` : "", newDyn ? "+dynamic(*)" : ""].filter(Boolean).join(" "); drift++; } else if (c.version && p.version && c.version !== p.version) { mark = `~ ${p.version}→${c.version}`; }
			}

			// A new dep or a capability/member expansion that entered via likely-AI-authored code: flag it.
			if ((mark.startsWith("+ new") || mark.startsWith("↑")) && aiIntroduced(ws, spec)) { mark += `  ⚠ likely-AI · ${reviewState(ws, spec)}`; aiChanges++; }
			console.log(`      ${label.padEnd(width)}  ${use.members.join(", ") || "—"}${use.dynamic ? " *" : ""}  →  ${caps.join(", ") || "none"}${mark ? `   ${mark}` : ""}`);
		}

		for (const s of Object.keys(pws).filter((s) => !(s in cur))) { console.log(`      − removed   ${s}`); }
	}

	for (const ws of Object.keys(prev).filter((w) => !(w in next))) { console.log(`    − removed workspace ${ws}`); }
	if (aiChanges) { console.log(`\n  ⚠ ${aiChanges} capability change(s) introduced by likely-AI-authored code — review with extra scrutiny`); }
	b.consumer = next;

	return drift;
}

/** NODE_MODULES: each DIRECT dependency's whole-package capability fingerprint. Mutates b.packages. */
export async function auditPackages(b: Baseline): Promise<number> {
	let pj: any;

	try { pj = JSON.parse(fs.readFileSync(path.join(PROJECT, "package.json"))); } catch {
		console.log("\n  node_modules — no package.json, skipped");

		return 0;
	}

	const deps = [...new Set(Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.optionalDependencies }))].sort();
	const prev = b.packages; const
		next: Record<string, PkgEntry> = {};
	let drift = 0;

	console.log(`\n  node_modules — ${deps.length} direct dependencies`);
	const width = Math.max(12, ...deps.map((d) => d.length + 9));

	for (const pkg of deps) {
		const c = classify(pkg, PROJECT);
		// pkg@version → caps is immutable, so a hit is always valid; unknown version isn't a stable key.
		const caps = await fingerprint(c.version === undefined ? undefined : `${pkg}@${c.version}`, () => wholePackageCaps(pkg, PROJECT, PROJECT));

		next[pkg] = { "version": c.version, "caps": caps };
		const p = prev[pkg]; let mark = "";

		if (!p) { mark = "+ new"; drift++; } else {
			const gC = caps.filter((x) => !(p.caps ?? []).includes(x));
			const verChanged = c.version && p.version && c.version !== p.version;

			if (gC.length) { mark = `↑ +cap ${gC.join(",")}${verChanged ? ` (${p.version}→${c.version})` : ""}`; drift++; } else if (verChanged) { mark = `~ ${p.version}→${c.version}`; }
		}

		console.log(`    ${`${pkg}@${c.version ?? "?"}`.padEnd(width)}  ${caps.join(", ") || "none"}${mark ? `   ${mark}` : ""}`);
	}

	for (const s of Object.keys(prev).filter((s) => !(s in next))) { console.log(`    − removed   ${s}`); }
	b.packages = next;

	return drift;
}

/** Project capability drift vs the committed baseline — the two-sided count bare `silo` gates on, PLUS the
 *  trust-ratchet units (`gated`: touched, capability-bearing, unreviewed), packaged for the runner to ride
 *  ahead of a script. Uses reviewStates() (lint-free) so it never spawns eslint. `fresh` = no baseline yet
 *  → nothing to gate against (defer to onboarding, not a block). */
export async function capabilityDrift(target: string, consumerOnly = false): Promise<{ "drift": number; "fresh": boolean; "gated": UnitState[] }> {
	if (!fs.existsSync(BASELINE)) { return { "drift": 0, "fresh": true, "gated": [] }; }
	const b = loadBaseline();
	const review = reviewStates();
	const exposed = new Set<string>();
	const drift = (await auditConsumer(b, target, fileStates(review), exposed)) + (consumerOnly ? 0 : await auditPackages(b));

	await flushFingerprints();

	return { "drift": drift, "fresh": false, "gated": gateUnits(review, exposed, touchedUnits(baseRef())) };
}

/** First-run onboarding: no committed baseline yet, so accept the CURRENT two-sided surface as the starting
 *  point (the same TOFU bare `silo` does on a fresh project) and write it. auditConsumer/auditPackages PRINT
 *  the surface as they compute it, so it's seen — not silently stamped. The trust ratchet still governs every
 *  later expansion; this only sets the capability starting line. */
export async function establishBaseline(target: string): Promise<void> {
	const b = loadBaseline();
	const exposed = new Set<string>();

	await auditConsumer(b, target, new Map<string, Understood>(), exposed);
	await auditPackages(b);
	await flushFingerprints();
	await saveBaseline(b);
}
