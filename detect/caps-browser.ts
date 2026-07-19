/**
 * Browser replacement for package-capabilities.ts's rolldown DCE (which needs node_modules + a bundler).
 * Recipe (parity-verified — see [[silo-npm-extension]]): esm.sh `?target=node&bundle` → webcrack → detect.
 * Coarser than the CLI, and fails closed: any failure → `?`, which isDangerous treats as dangerous.
 */
import { webcrack } from "webcrack";
import { isDangerous } from "../policy/capability-policy.js";
import { builtinCaps, classifyKind, detect, refine, surfaceOfSource } from "./analysis-core.js";

const ESM = "https://esm.sh";
const CHUNK_CAP = 24;

function esmUrl(spec: string, version?: string): string {
	const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
	const pinned = version !== undefined ? `${pkg}@${version}` : pkg;

	// ?target=node keeps the node: builtin edges — esm.sh shims them away by default, killing the fs/net signal.
	return `${ESM}/${pinned}${spec.slice(pkg.length)}?target=node&bundle`;
}

/** esm.sh's entry is a re-export facade (`export * from "/pkg@ver/…bundle.mjs"`); follow the `/…` chunk URLs it
 *  names (bounded) and concatenate, so detect sees every chunk's node: edges. */
async function esmBundle(spec: string, version?: string): Promise<string | undefined> {
	const seen = new Set<string>();
	const queue = [esmUrl(spec, version)];
	const parts: string[] = [];

	while (queue.length && seen.size < CHUNK_CAP) {
		const url = queue.shift() as string;

		if (seen.has(url)) { continue; }
		seen.add(url);
		const res = await fetch(url);

		if (!res.ok) {
			if (parts.length === 0) { return undefined; }   // entry 404 (e.g. unpublished version)
			continue;                                        // a sub-chunk failed — analyze what resolved
		}
		const text = await res.text();

		parts.push(text);
		for (const m of text.matchAll(/from\s*["'](\/[^"']+)["']/gu)) { queue.push(ESM + m[1]); }
	}

	return parts.length ? parts.join("\n") : undefined;
}

const capCache = new Map<string, Promise<string[]>>();

/** Capabilities a package can reach — the browser analog of `capsOf`. Cached per spec@version; never throws. */
export function capsOfPackage(spec: string, version?: string): Promise<string[]> {
	const key = `${spec}|${version ?? ""}`;

	if (!capCache.has(key)) {
		capCache.set(key, (async () => {
			try {
				const bundled = await esmBundle(spec, version);

				if (bundled === undefined) { return ["?"]; }
				const { code } = await webcrack(bundled);   // un-thunk + de-minify so reachability survives

				return refine(detect(code));
			} catch {
				return ["?"];
			}
		})());
	}

	return capCache.get(key) as Promise<string[]>;
}

export interface FileCaps { "caps": string[]; "exposed": boolean }

/** Capabilities a file exposes: its builtin caps + its third-party deps' caps, unioned. `exposed` = reaches a
 *  dangerous cap (mirrors the CLI). `versions` pins deps to the installed version when known. */
export async function exposedOfSource(file: string, src: string, versions: Record<string, string> = {}): Promise<FileCaps> {
	const surface = surfaceOfSource(file, src);
	const caps = new Set<string>();

	await Promise.all([...surface].map(async ([spec, use]) => {
		const c = classifyKind(spec);

		if (c.kind === "local") { return; }
		if (c.kind === "builtin") { builtinCaps(spec, [...use.members], use.dynamic).forEach((x) => caps.add(x)); return; }
		(await capsOfPackage(spec, versions[c.pkg as string])).forEach((x) => caps.add(x));
	}));

	return { "caps": [...caps].sort(), "exposed": [...caps].some(isDangerous) };
}
