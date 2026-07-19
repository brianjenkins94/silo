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
	/** Async setup (e.g. instantiate oxc-wasm). No-op for the stopgap. */
	"init": () => Promise<void>;
	/** For each baked unit in a document, resolve its live range, `understood`, and record hash. */
	"resolve": (document: vscode.TextDocument, units: readonly BakedUnit[], store: ReviewStore) => Promise<Map<string, ResolvedUnit>>;
	/** Told when a unit was just marked, so a session-baseline provider (the stopgap) can re-anchor. */
	"onMarked"?: (id: string, understood: Understood, document: vscode.TextDocument) => void;
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
