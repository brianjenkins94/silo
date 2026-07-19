/**
 * Shared shape of the review-burndown model — computed by the extension (overlay.ts, from baked units + the
 * live review store) and consumed by the host custom view (vscode/burndown-view.ts) over a command bridge.
 * Types only (no imports), so both the esbuild-bundled extension and the vite-bundled host can share it.
 */
export type Understood = "reviewed" | "waived" | "stale" | "unreviewed";
export type Tone = "gated" | "reviewed" | "attention" | "untracked";

export interface JumpItem {
	"id": string;
	"file": string;
	"fn": string;
	"lines": number;
	"state": Understood;
	"tone": Tone;
	"origin": "clean" | "possible" | "likely";
}

export interface BurndownModel {
	"total": number;          // reviewable lines across the codebase
	"handled": number;        // reviewed + waived lines
	"pending": number;        // unreviewed + stale lines
	"pct": number;            // handled / total, 0..1
	"counts": Record<Understood, number>;
	"gatedPending": number;   // pending units that are also gated (ratchet-relevant)
	"curve": number[];        // remaining pending lines after reviewing the top-k biggest, k = 0..jump.length
	"jump": JumpItem[];       // pending units, biggest first
}

export const TONE_COLOR: Record<Tone, string> = {
	"gated": "#f85149",
	"reviewed": "#3fb950",
	"attention": "#d29922",
	"untracked": "#6e7681"
};
