/**
 * PROTOTYPE — per-export capability fingerprint via tsgo's LSP call hierarchy.
 *
 * exports → recursive `callHierarchy/outgoingCalls` (descending into user functions AND nested
 * closures) → classify each callee by its *definition file* (`fs.d.ts` → fs, `child_process.d.ts`
 * → exec, `net/http/…` or `fetch`/`WebSocket` → net, `eval`/`Function` → eval). Type-precise, and
 * it yields the call *path*. Requires a typed Program — unresolved callees produce no edge, so a
 * real impl must flag them; here we just rely on a tsconfig that resolves @types/node.
 *
 * Run: ./node_modules/.bin/tsx scripts/engines/static-caps-lsp.ts <targetFile>
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "engines/static-caps-lsp.ts";
const FILE = path.isAbsolute(fileArg) ? fileArg : path.resolve(process.cwd(), fileArg);
const JSON_MODE = process.argv.includes("--json");
const URI = "file://" + FILE;
const TSGO = process.env.TSGO ?? path.join(ROOT, "node_modules/.bin/tsgo");

// ── capability classification from a callee's definition file + name ──
function classify(item: any): string | null {
	const file = (item.uri ?? "").replace("file://", "");
	const b = path.basename(file), n = item.name;
	if (b === "fs.d.ts" || b === "promises.d.ts") {
		if (/^(read|exists|stat|realpath|access|opendir|readdir|watch)/u.test(n) || n === "createReadStream") return "fs:read";
		if (/^(write|append|mkdir|unlink|rm|rename|copy|chmod|chown|truncate|symlink|link|utimes|open)/u.test(n) || n === "createWriteStream") return "fs:write";
		return "fs";
	}
	if (b === "child_process.d.ts") return "exec";
	if (["net.d.ts", "http.d.ts", "https.d.ts", "http2.d.ts", "tls.d.ts", "dgram.d.ts"].includes(b)) return "net";
	if (["fetch", "WebSocket", "XMLHttpRequest", "EventSource"].includes(n)) return "net";
	if (n === "eval" || n === "Function") return "eval";
	return null;
}
const isUserCode = (uri = "") => { const f = uri.replace("file://", ""); return f.startsWith(ROOT) && !f.includes("/node_modules/") && !f.endsWith(".d.ts"); };
const valueExports = (src: string) => [...new Set([...src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gmu), ...src.matchAll(/^export\s+const\s+(\w+)/gmu)].map((m) => m[1]))];

// ── minimal LSP client ──
const p = spawn(TSGO, ["--lsp", "-stdio"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0); const pending = new Map<number, any>(); let nextId = 1;
const frame = (o: any) => { const s = JSON.stringify(o); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
const request = (method: string, params: any) => { const id = nextId++; const pr = new Promise<any>((res, rej) => pending.set(id, { res, rej })); frame({ jsonrpc: "2.0", id, method, params }); return pr; };
const notify = (method: string, params: any) => frame({ jsonrpc: "2.0", method, params });
p.stdout.on("data", (d) => {
	buf = Buffer.concat([buf, d]);
	while (true) {
		const he = buf.indexOf("\r\n\r\n"); if (he === -1) break;
		const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString()); if (!m) { buf = buf.slice(he + 4); continue; }
		const len = +m[1], start = he + 4; if (buf.length < start + len) break;
		const msg = JSON.parse(buf.slice(start, start + len).toString()); buf = buf.slice(start + len);
		if (msg.id !== undefined && msg.method) frame({ jsonrpc: "2.0", id: msg.id, result: null });
		else if (msg.id !== undefined) { const pr = pending.get(msg.id); pending.delete(msg.id); if (pr) (msg.error ? pr.rej(msg.error) : pr.res(msg.result)); }
	}
});
const flatten = (s: any[], out: any[] = []): any[] => { for (const x of s ?? []) { out.push(x); if (x.children) flatten(x.children, out); } return out; };

async function reach(item: any, visited: Set<string>, trail: string[], found: { cap: string, path: string[] }[]) {
	const key = item.uri + JSON.stringify(item.range); if (visited.has(key)) return; visited.add(key);
	for (const c of (await request("callHierarchy/outgoingCalls", { item }) ?? [])) {
		const cap = classify(c.to);
		if (cap) found.push({ cap, path: [...trail, c.to.name] });
		else if (isUserCode(c.to.uri)) await reach(c.to, visited, [...trail, c.to.name], found);
	}
}

(async () => {
	// prototype scaffolding: ensure node types resolve
	const tsc = path.join(ROOT, "tsconfig.json"); const madeTsconfig = !existsSync(tsc);
	if (madeTsconfig) writeFileSync(tsc, JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", types: ["node"], typeRoots: ["node_modules/@types"], noEmit: true }, include: ["**/*.ts"] }, null, 2));
	try {
		await request("initialize", { processId: process.pid, rootUri: "file://" + ROOT, workspaceFolders: [{ uri: "file://" + ROOT, name: "silo" }], capabilities: { textDocument: { callHierarchy: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } }, clientInfo: { name: "static-caps-lsp", version: "0" } });
		notify("initialized", {});
		notify("textDocument/didOpen", { textDocument: { uri: URI, languageId: "typescript", version: 1, text: readFileSync(FILE, "utf8") } });
		await new Promise((r) => setTimeout(r, 900));
		// Seed roots from ALL top-level functions/vars (SymbolKind Function=12, Method=6, Variable=13,
		// Constant=14), NOT just exports — so the non-exported entry (`main`) is rooted and its caps
		// (e.g. fs) are counted. Over-approximates (a dead helper still gets analyzed) — the safe bias.
		const docSyms: any[] = await request("textDocument/documentSymbol", { textDocument: { uri: URI } }) ?? [];
		const roots = docSyms.filter((s) => [12, 6, 13, 14].includes(s.kind));

		const perRoot: Record<string, { caps: string[]; paths: string[][] }> = {};
		const allCaps = new Set<string>();
		for (const sym of roots) {
			const pos = (sym.selectionRange ?? sym.range ?? sym.location?.range).start;
			const items = await request("textDocument/prepareCallHierarchy", { textDocument: { uri: URI }, position: pos });
			const found: { cap: string, path: string[] }[] = [];
			if (items?.length) await reach(items[0], new Set(), [], found);
			if (!found.length) continue;   // pure roots (incl. plain consts) contribute nothing
			const caps = [...new Set(found.map((f) => f.cap))];
			perRoot[sym.name] = { caps, paths: found.map((f) => [sym.name, ...f.path]) };
			caps.forEach((c) => allCaps.add(c));
		}
		if (JSON_MODE) {
			console.log(JSON.stringify({ caps: [...allCaps], perExport: perRoot }));
		} else {
			const names = Object.keys(perRoot);
			console.log(`target: ${path.relative(process.cwd(), FILE)}   roots: ${roots.length}   (via tsgo callHierarchy)\n`);
			const width = Math.max(8, ...names.map((e) => e.length));
			if (!names.length) console.log("  (no capabilities reached)");
			for (const name of names) {
				console.log(`  ${name.padEnd(width)}  ${perRoot[name].caps.join(", ")}`);
				for (const p of perRoot[name].paths) console.log(`  ${" ".repeat(width)}    └ ${p.join(" → ")}`);
			}
		}
		await request("shutdown", {}).catch(() => {}); notify("exit", {});
	} finally {
		if (madeTsconfig) rmSync(tsc, { force: true });
		setTimeout(() => { p.kill(); process.exit(0); }, 300);
	}
})().catch((e) => { console.error("ERR", e); p.kill(); process.exit(1); });
setTimeout(() => { console.log("(timeout)"); p.kill(); process.exit(1); }, 20000);
