/**
 * The review overlay — environment-agnostic UX, driven by a swappable {@link UnitProvider}.
 *
 * This owns everything that doesn't depend on HOW units are detected/hashed: reading the baked snapshot
 * (`.silo/review-units.json` — the git/eslint-derived exposed/touched/lint/origin, which can't run in the
 * browser), reading/writing the review store (`.silo/review.json`, silo's on-disk format), the tone
 * coloring, decorations, CodeLens, and marking. The one thing it delegates is the LIVE review axis —
 * each unit's range + `understood` + the hash to record on sign-off — to the {@link UnitProvider}
 * (provider-core: silo's review-core via a runtime-import()'d oxc-wasm module — exact, CLI-identical).
 */
import * as vscode from "vscode";
import { type BurndownModel, type JumpItem, type Tone, TONE_COLOR } from "./burndown-model";
import type { ReviewStore, Understood } from "../../../commands/review-core";
// Shared, oxc-free review rules — so the overlay's store format + gate rule stay identical to the CLI's.
import { isGated, reviewRecord, serializeStore } from "../../../commands/review-store";
// Pure (no oxc) — safe to bundle into the extension; redacts secrets before a session transform is persisted.
import { redactSecrets } from "../../../commands/redact";
import type { AttributedTransform } from "../../../commands/session-core";   // type only — erased, no oxc in the bundle

export type { Understood };

/** A baked review unit from `.silo/review-units.json` (silo `review --json` output). */
export interface BakedUnit {
	"id": string;
	"file": string;
	"hash"?: string;
	"startLine": number;
	"endLine": number;
	"understood": Understood;
	"errors": number;
	"warnings": number;
	"origin": "clean" | "possible" | "likely";
	"priority": number;
	"exposed"?: boolean;
	"touched"?: boolean;
	"gated"?: boolean;
}

/** What a provider resolves per unit, live: its current range, review state, and the hash to record. */
export interface ResolvedUnit { "range": vscode.Range; "understood": Understood; "hash": string }

/** The swappable "compute the live review axis" seam. */
export interface UnitProvider {
	/** Async setup: the web provider import()s the served oxc-wasm core; the native provider warms the parser. */
	"init": () => Promise<void>;
	/** For each baked unit in a document, resolve its live range, `understood`, and record hash. */
	"resolve": (document: vscode.TextDocument, units: readonly BakedUnit[], store: ReviewStore) => Promise<Map<string, ResolvedUnit>>;
	/** Told when a unit was just marked, so a session-baseline provider (the stopgap) can re-anchor. */
	"onMarked"?: (id: string, understood: Understood, document: vscode.TextDocument) => void;
	/** Baseline→final transforms with call-graph attribution to the focal unit (oxc core) — for the recorder. */
	"attributedTransforms"?: (focalId: string, baseline: Record<string, string>, final: Record<string, string>) => Promise<AttributedTransform[]>;
}

const LABEL: Record<Understood, { "glyph": string; "word": string }> = {
	"reviewed": { "glyph": "●", "word": "reviewed" },
	"waived": { "glyph": "◑", "word": "waived" },
	"stale": { "glyph": "◐", "word": "stale" },
	"unreviewed": { "glyph": "○", "word": "unreviewed" }
};

const TONES: Tone[] = ["gated", "reviewed", "attention", "untracked"];

const STORE_PATH = [".silo", "review.json"];
const UNITS_PATH = [".silo", "review-units.json"];
const SESSIONS_PATH = [".silo", "sessions.jsonl"];

async function readJson<T>(uri: vscode.Uri | undefined, fallback: T): Promise<T> {
	if (uri === undefined) { return fallback; }

	try { return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as T; } catch { return fallback; }
}

export async function activateOverlay(context: vscode.ExtensionContext, provider: UnitProvider): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	const folderUri = workspaceFolder?.uri;
	const folder = folderUri?.path ?? "";

	const baked = (await readJson<{ "units"?: BakedUnit[] }>(folderUri && vscode.Uri.joinPath(folderUri, ...UNITS_PATH), {})).units ?? [];
	const store = await readJson<ReviewStore>(folderUri && vscode.Uri.joinPath(folderUri, ...STORE_PATH), {});

	await provider.init();

	// Baked units by repo-relative file, dropping the `#<module>` glue unit (no range to decorate).
	const byFile = new Map<string, BakedUnit[]>();

	for (const unit of baked) {
		if (unit.endLine <= 0) { continue; }
		const list = byFile.get(unit.file) ?? [];

		list.push(unit);
		byFile.set(unit.file, list);
	}

	const relativeOf = (uri: vscode.Uri) => (uri.path.startsWith(folder + "/") ? uri.path.slice(folder.length + 1) : uri.path.replace(/^\//u, ""));
	const unitsFor = (document: vscode.TextDocument) => byFile.get(relativeOf(document.uri)) ?? [];
	const bakedRange = (u: BakedUnit) => new vscode.Range(Math.max(0, u.startLine - 1), 0, Math.max(0, u.endLine - 1), 0);

	// Live resolution keyed by unit id, refreshed by the provider.
	const resolved = new Map<string, ResolvedUnit>();
	const understoodOf = (u: BakedUnit) => resolved.get(u.id)?.understood ?? u.understood;
	const rangeOf = (u: BakedUnit) => resolved.get(u.id)?.range ?? bakedRange(u);

	/** COLOR axis: gated wins, recomputed live (exposed && touched && the current state is unread). */
	function toneOf(u: BakedUnit): Tone {
		const state = understoodOf(u);

		if (isGated(u.exposed === true, u.touched === true, state)) { return "gated"; }
		if (state === "reviewed") { return "reviewed"; }
		if (state === "waived" || state === "stale") { return "attention"; }

		return "untracked";
	}

	const decorations = Object.fromEntries(TONES.map((tone) => [tone, vscode.window.createTextEditorDecorationType({
		"isWholeLine": true,
		"borderWidth": "0 0 0 2px",
		"borderStyle": "solid",
		"borderColor": TONE_COLOR[tone],
		...(tone === "untracked" ? {} : { "overviewRulerColor": TONE_COLOR[tone], "overviewRulerLane": vscode.OverviewRulerLane.Left })
	})])) as Record<Tone, vscode.TextEditorDecorationType>;

	context.subscriptions.push(...Object.values(decorations));

	function decorate(editor: vscode.TextEditor): void {
		const buckets: Record<Tone, vscode.Range[]> = { "gated": [], "reviewed": [], "attention": [], "untracked": [] };

		for (const unit of unitsFor(editor.document)) { buckets[toneOf(unit)].push(rangeOf(unit)); }
		for (const tone of TONES) { editor.setDecorations(decorations[tone], buckets[tone]); }
	}

	const changed = new vscode.EventEmitter<void>();

	/** Ask the provider to re-resolve a document's units, then re-render. */
	async function refresh(document: vscode.TextDocument): Promise<void> {
		const units = unitsFor(document);

		if (units.length === 0) { return; }
		for (const [id, ru] of await provider.resolve(document, units, store)) { resolved.set(id, ru); }
		for (const editor of vscode.window.visibleTextEditors) { if (editor.document === document) { decorate(editor); } }
		changed.fire();
	}

	const refreshAll = () => { for (const editor of vscode.window.visibleTextEditors) { void refresh(editor.document); } };

	for (const editor of vscode.window.visibleTextEditors) { decorate(editor); }
	refreshAll();
	context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(refreshAll));

	// Live: re-resolve the edited document (debounced — the provider may do a symbol query / reparse).
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
		const key = event.document.uri.toString();

		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => { void refresh(event.document); }, 350));
	}));

	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ "pattern": "**/*" }, {
		"onDidChangeCodeLenses": changed.event,
		"provideCodeLenses": (document) => unitsFor(document).flatMap((unit) => {
			const at = new vscode.Range(rangeOf(unit).start.line, 0, rangeOf(unit).start.line, 0);
			const state = understoodOf(unit);
			const label = LABEL[state];
			const bits = [toneOf(unit) === "gated" ? `⚠ gated · ${label.word}` : `${label.glyph} ${label.word}`];

			if (unit.origin !== "clean") { bits.push(unit.origin === "likely" ? "likely AI" : "possibly AI"); }
			if (unit.errors) { bits.push(`${unit.errors}e`); } else if (unit.warnings) { bits.push(`${unit.warnings}w`); }

			const lenses = [new vscode.CodeLens(at, { "title": `silo: ${bits.join(" · ")}`, "command": "" })];

			if (state !== "reviewed") { lenses.push(new vscode.CodeLens(at, { "title": "Review", "command": "silo.review.mark", "arguments": [unit.id] })); }
			if (state !== "reviewed" && state !== "waived") { lenses.push(new vscode.CodeLens(at, { "title": "Waive", "command": "silo.review.waive", "arguments": [unit.id] })); }

			return lenses;
		})
	}));

	// A session = the focal unit + a baseline snapshot of every open code file when it was focused (jumped to
	// from the burndown), so the ripple — units changed while improving the focal unit, INCLUDING in other open
	// files — is captured, then attributed to the focal unit by call-graph distance.
	const isCode = (file: string) => /\.(m|c)?[jt]sx?$/u.test(file);
	let session: { "focalId": string; "baseline": Map<string, string> } | undefined;
	const unitSourceAt = (document: vscode.TextDocument, startLine: number, endLine: number) =>
		document.getText().split("\n").slice(Math.max(0, startLine - 1), endLine).join("\n");

	const snapshotOpenDocs = (baseline: Map<string, string>): void => {
		for (const doc of vscode.workspace.textDocuments) {
			const rel = relativeOf(doc.uri);

			if (doc.uri.scheme === "file" && isCode(rel) && !baseline.has(rel)) { baseline.set(rel, doc.getText()); }
		}
	};

	// Files opened DURING a session get snapshotted too (you open a file to edit it) — so cross-file ripple has a
	// focus-time baseline to diff against.
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
		const rel = relativeOf(doc.uri);

		if (session !== undefined && doc.uri.scheme === "file" && isCode(rel) && !session.baseline.has(rel)) { session.baseline.set(rel, doc.getText()); }
	}));

	type Rec = { "id": string; "action": string; "attribution": string; "before"?: string; "after"?: string };

	// The burndown-to-record slice: on APPROVAL of the focal unit, record what getting it approved took — the
	// focal transform + its call-graph-connected ripple (across files) — to the session log (the corpus feed).
	// `incidental` co-changes are dropped (they belong to their own unit's session). All sources redacted.
	const recordSession = async (id: string, document: vscode.TextDocument): Promise<void> => {
		if (session === undefined || session.focalId !== id || folderUri === undefined) { return; }
		const { baseline } = session;

		session = undefined;
		const final: Record<string, string> = {};

		for (const rel of baseline.keys()) {
			const open = vscode.workspace.textDocuments.find((doc) => relativeOf(doc.uri) === rel);

			if (open !== undefined) { final[rel] = open.getText(); } else {
				try { final[rel] = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folderUri, ...rel.split("/")))); } catch { final[rel] = baseline.get(rel) ?? ""; }
			}
		}

		const attributed = (await provider.attributedTransforms?.(id, Object.fromEntries(baseline), final)) ?? [];
		const transforms: Rec[] = attributed
			.filter((t) => t.attribution !== "incidental")
			.map((t) => ({ "id": t.id, "action": t.action, "attribution": t.attribution, "before": t.before === undefined ? undefined : redactSecrets(t.before), "after": t.after === undefined ? undefined : redactSecrets(t.after) }));

		// Focal approved as-is (no edit) → not in the diff; record it anyway.
		if (!transforms.some((t) => t.id === id)) {
			const unit = baked.find((u) => u.id === id);
			const live = resolved.get(id)?.range;
			const source = redactSecrets(unitSourceAt(document, live !== undefined ? live.start.line + 1 : unit?.startLine ?? 1, live !== undefined ? live.end.line + 1 : unit?.endLine ?? 1));

			transforms.unshift({ "id": id, "action": "unchanged", "attribution": "direct", "before": source, "after": source });
		}

		const record = { "focal": id, "at": new Date().toISOString(), "transforms": transforms };
		const uri = vscode.Uri.joinPath(folderUri, ...SESSIONS_PATH);
		let existing = "";

		try { existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { /* first record — new file */ }
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(existing + JSON.stringify(record) + "\n"));
		console.log(`[silo] session recorded ${id} — ${transforms.length} transform(s): ${transforms.map((t) => t.attribution + ":" + t.action).join(", ")}`);
	};

	// Marking: persist to the review store in silo's exact format, then let the provider re-anchor and
	// re-render. The recorded hash comes from the provider (silo's live hash for core; the baked hash for
	// the stopgap, which can't reproduce silo's byte-spans).
	const setState = async (id: string, understood: Understood) => {
		const unit = baked.find((u) => u.id === id);

		if (unit === undefined) { return; }
		const hash = resolved.get(id)?.hash ?? unit.hash ?? "";

		store[id] = reviewRecord(hash, understood === "waived");
		if (folderUri !== undefined) {
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folderUri, ...STORE_PATH), new TextEncoder().encode(serializeStore(store)));
		}

		const editor = vscode.window.visibleTextEditors.find((ed) => relativeOf(ed.document.uri) === unit.file);

		if (editor !== undefined) {
			provider.onMarked?.(id, understood, editor.document);
			await refresh(editor.document);
			if (understood === "reviewed") { await recordSession(id, editor.document); }
		}

		changed.fire();
		vscode.window.setStatusBarMessage(`silo: ${id} → ${understood}`, 3000);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("silo.review.mark", (id: string) => void setState(id, "reviewed")),
		vscode.commands.registerCommand("silo.review.waive", (id: string) => void setState(id, "waived"))
	);

	// ── The burndown view (auxiliary bar): a chart + biggest-first jump list, driven by the model below. ──
	const HANDLED = new Set<Understood>(["reviewed", "waived"]);
	const sizeOf = (u: BakedUnit) => Math.max(1, u.endLine - u.startLine + 1);
	const fnOf = (id: string) => { const i = id.indexOf("#"); return i >= 0 ? id.slice(i + 1) : id; };

	// state that also honours in-session marks on files that aren't currently open (resolved is per-open-doc).
	const stateOf = (u: BakedUnit): Understood => {
		const live = resolved.get(u.id);

		if (live !== undefined) { return live.understood; }
		const rec = store[u.id];

		if (rec !== undefined) { return rec.waived === true ? "waived" : "reviewed"; }

		return u.understood;
	};

	function model(): BurndownModel {
		const rows = baked.filter((u) => u.endLine > 0).map((u) => ({ "u": u, "lines": sizeOf(u), "state": stateOf(u) }));
		const counts: Record<Understood, number> = { "reviewed": 0, "waived": 0, "stale": 0, "unreviewed": 0 };
		let total = 0; let handled = 0;

		for (const r of rows) { total += r.lines; counts[r.state] += 1; if (HANDLED.has(r.state)) { handled += r.lines; } }
		const pending = total - handled;
		// Biggest first = biggest impact on the reviewed %. The curve burns that order down to zero.
		const pendingRows = rows.filter((r) => !HANDLED.has(r.state)).sort((a, b) => b.lines - a.lines);
		const curve = [pending];
		let rem = pending;

		for (const r of pendingRows) { rem -= r.lines; curve.push(Math.max(0, rem)); }
		const jump: JumpItem[] = pendingRows.map((r) => ({ "id": r.u.id, "file": r.u.file, "fn": fnOf(r.u.id), "lines": r.lines, "state": r.state, "tone": toneOf(r.u), "origin": r.u.origin }));

		return { "total": total, "handled": handled, "pending": pending, "pct": total ? handled / total : 1, "counts": counts, "gatedPending": jump.filter((j) => j.tone === "gated").length, "curve": curve, "jump": jump };
	}

	const jumpTo = async (id: string): Promise<void> => {
		const unit = baked.find((u) => u.id === id);

		if (unit === undefined || folderUri === undefined) { return; }
		try {
			const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folderUri, unit.file)), { "preview": false });
			const target = new vscode.Range(Math.max(0, unit.startLine - 1), 0, Math.max(0, unit.endLine - 1), 0);

			editor.revealRange(target, vscode.TextEditorRevealType.InCenter);
			editor.selection = new vscode.Selection(target.start, target.start);
			session = { "focalId": id, "baseline": new Map() };   // start a session; baseline = every open code file
			snapshotOpenDocs(session.baseline);
		} catch (error) { console.error("[silo] jumpTo failed", id, error); }
	};

	// The host burndown view (vscode/burndown-view.ts, an auxiliary-bar custom view) drives itself through
	// these — the extension stays the single source of truth for the model + navigation.
	context.subscriptions.push(
		vscode.commands.registerCommand("silo.review.model", () => model()),
		vscode.commands.registerCommand("silo.review.jump", (id: string) => void jumpTo(id))
	);

	console.log(`[silo] review overlay active — ${baked.length} units across ${byFile.size} files`);
}
