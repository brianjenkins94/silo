/**
 * The review burndown, as a HOST custom view (not a webview) — `registerCustomView` hands us a real DOM
 * element (`renderBody`), so billboard.js renders into it directly: composites everywhere (unlike the
 * sandboxed webview iframe) and sits in the AUXILIARY BAR (the auxpane). Real DOM in the workbench document,
 * so it inherits the `--vscode-*` theme variables for free.
 *
 * The model (units + review state) is owned by the extension; we fetch it and drive actions over a command
 * bridge (`silo.review.model` / `silo.review.jump` / `silo.review.mark` / `silo.review.waive`), so the
 * extension store stays the single source of truth and its decorations stay in sync.
 */
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";
import bb, { area } from "billboard.js";
import "billboard.js/dist/billboard.css";
import { type BurndownModel, TONE_COLOR } from "./extensions/silo/burndown-model";

// Minimal vscode command surface we use (the extension's per-view API, captured post-boot).
interface Api { "commands": { "executeCommand": <T = unknown>(command: string, ...args: unknown[]) => Promise<T> } }

const SHIELD = "data:image/svg+xml;base64," + btoa(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>'
);

const esc = (s: string) => s.replace(/[&<>]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** Register the burndown custom view (call at module load, before boot). `getApi` resolves the extension's
 *  vscode API once it's ready (post-activation). */
export function registerBurndownView(getApi: () => Promise<Api>): void {
	registerCustomView({
		"id": "silo.burndown",
		"name": "Review Burndown",
		"order": 0,
		"location": ViewContainerLocation.AuxiliaryBar,
		"icon": SHIELD,
		"renderBody": (container: HTMLElement) => {
			container.innerHTML = `
				<style>
					.silo-bd { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); height: 100%; overflow-y: auto; }
					.silo-bd .pct { font-size: 22px; font-weight: 600; padding: 10px 12px 2px; }
					.silo-bd .sub { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 0 12px 6px; }
					.silo-bd .chart { height: 150px; margin: 0 4px; }
					.silo-bd .chart .bb-axis text { fill: var(--vscode-descriptionForeground); }
					.silo-bd .chart .bb line, .silo-bd .chart path.domain, .silo-bd .chart .bb-grid line { stroke: var(--vscode-panel-border, #4444); }
					.silo-bd .hdr { margin: 10px 12px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); font-weight: 600; }
					.silo-bd .empty { padding: 24px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
					.silo-bd .row { display: flex; align-items: center; gap: 8px; padding: 4px 12px; cursor: pointer; border-left: 2px solid transparent; }
					.silo-bd .row:hover { background: var(--vscode-list-hoverBackground); }
					.silo-bd .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
					.silo-bd .lines { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); min-width: 34px; text-align: right; font-size: 11px; }
					.silo-bd .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
					.silo-bd .name .file { color: var(--vscode-descriptionForeground); }
					.silo-bd .name .fn { color: var(--vscode-symbolIcon-functionForeground, var(--vscode-foreground)); font-weight: 600; }
					.silo-bd .gatedbadge { color: #f85149; font-size: 10px; flex: 0 0 auto; }
					.silo-bd .actions { flex: 0 0 auto; display: flex; gap: 2px; opacity: 0; }
					.silo-bd .row:hover .actions { opacity: 1; }
					.silo-bd .actions button { background: transparent; border: 1px solid var(--vscode-panel-border, #4444); color: var(--vscode-foreground); border-radius: 3px; cursor: pointer; width: 22px; height: 20px; font-size: 12px; line-height: 1; padding: 0; }
					.silo-bd .actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
				</style>
				<div class="silo-bd">
					<div class="pct">—</div>
					<div class="sub">loading…</div>
					<div class="chart"></div>
					<div class="hdr" style="display:none">Biggest first</div>
					<div class="jump"></div>
					<div class="empty" style="display:none">✓ Nothing pending — the codebase is fully reviewed.</div>
				</div>`;

			const q = (sel: string) => container.querySelector(sel) as HTMLElement;
			const chartEl = q(".chart"); const jumpEl = q(".jump");
			const accent = getComputedStyle(document.body).getPropertyValue("--vscode-charts-blue").trim() || "#4e9bd6";
			let chart: ReturnType<typeof bb.generate> | undefined;
			let last = "";
			let disposed = false;

			const render = (m: BurndownModel) => {
				const empty = m.jump.length === 0;

				q(".pct").textContent = Math.round(m.pct * 100) + "% reviewed";
				q(".sub").textContent = `${m.handled.toLocaleString()} / ${m.total.toLocaleString()} lines · ${m.jump.length} pending${m.gatedPending ? ` · ${m.gatedPending} gated` : ""}`;
				q(".empty").style.display = empty ? "block" : "none";
				q(".hdr").style.display = empty ? "none" : "block";

				chart?.destroy();
				chart = undefined;
				if (!empty) {
					chart = bb.generate({
						"bindto": chartEl,
						"data": { "x": "x", "columns": [["x", ...m.curve.map((_, i) => i)], ["remaining", ...m.curve]], "types": { "remaining": area() }, "colors": { "remaining": accent } },
						"point": { "show": false },
						"legend": { "show": false },
						"axis": { "x": { "tick": { "count": 5, "format": (v: number) => String(Math.round(v)) } }, "y": { "tick": { "count": 4, "format": (v: number) => (v >= 1000 ? Math.round(v / 100) / 10 + "k" : String(Math.round(v))) } } },
						"grid": { "y": { "show": true } },
						"tooltip": { "format": { "title": (x: number) => `review ${x} fn${x === 1 ? "" : "s"}`, "value": (v: number) => `${v.toLocaleString()} lines left` } }
					});
				}

				jumpEl.innerHTML = m.jump.map((it) => `
					<div class="row" data-id="${esc(it.id)}" style="border-left-color:${TONE_COLOR[it.tone]}">
						<span class="dot" style="background:${TONE_COLOR[it.tone]}"></span>
						<span class="lines">${it.lines}</span>
						<span class="name"><span class="file">${esc(it.file)}</span><span class="fn">#${esc(it.fn)}</span>${it.origin === "likely" ? " · likely AI" : it.origin === "possible" ? " · maybe AI" : ""}</span>
						${it.tone === "gated" ? '<span class="gatedbadge">⚠</span>' : ""}
						<span class="actions"><button data-act="mark" title="Mark reviewed">✓</button><button data-act="waive" title="Waive">~</button></span>
					</div>`).join("");
			};

			void (async () => {
				const api = await getApi();
				const refresh = async () => {
					try {
						const m = await api.commands.executeCommand<BurndownModel>("silo.review.model");
						const key = JSON.stringify(m);

						if (m && key !== last && !disposed) { last = key; render(m); }
					} catch { /* extension not ready yet — the poll will retry */ }
				};

				jumpEl.addEventListener("click", (event) => {
					const target = event.target as HTMLElement;
					const row = target.closest(".row") as HTMLElement | null;

					if (row === null) { return; }
					const id = row.dataset["id"] as string;
					const btn = target.closest("button[data-act]") as HTMLElement | null;

					if (btn !== null) {
						event.stopPropagation();
						void api.commands.executeCommand(btn.dataset["act"] === "mark" ? "silo.review.mark" : "silo.review.waive", id).then(refresh);
					} else {
						void api.commands.executeCommand("silo.review.jump", id);
					}
				});

				await refresh();
				// Reflect external changes (live edits → stale, CLI marks) without a manual refresh.
				const timer = setInterval(() => void refresh(), 4000);

				container.addEventListener("silo-dispose", () => clearInterval(timer), { "once": true });
			})();

			return {
				"dispose": () => {
					disposed = true;
					container.dispatchEvent(new Event("silo-dispose"));
					chart?.destroy();
				}
			};
		}
	});
}
