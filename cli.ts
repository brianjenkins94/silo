/**
 * silo — earned, bounded trust for scripts and dependencies. This is the command layer: it wires the
 * subcommands and orchestrates `baseline`, which joins the two axes —
 *   • CAPABILITY (audit.ts) — what your code and deps CAN do, vs a committed baseline.
 *   • QUALITY    (review.ts) — how much of the capability-bearing code you've actually READ.
 *
 *   silo                      the two-sided baseline (own code + node_modules) + the trust ratchet
 *   silo audit                consumer side only
 *   silo <script> [args…]     fingerprint → gate → box → execute under the broker (runner.ts)
 *   silo status               list managed scripts
 *   silo install [args…]      cooldown-aware install
 *   silo --reviewed <unit>    sign off a unit (I read it) · --waive <unit> (accepted unread)
 */
import * as fs from "@brianjenkins94/util/fs";
import { command, flag, group, optional, positional, run as runCli, string } from "@brianjenkins94/util/cmd";
import { auditConsumer, auditPackages, type Baseline, loadBaseline, saveBaseline } from "./commands/audit.js";
import { flushFingerprints } from "./shared/cache.js";
import { BASELINE, clearPending, PROJECT, readPending } from "./shared/paths.js";
import { baseRef, fileStates, gateUnits, markReviewed, printReview, reviewUnits, touchedUnits } from "./commands/review.js";
import { installCmd, run, status } from "./commands/runner.js";

/** Fail the gate. In GitHub Actions also emit a workflow error annotation (shows inline on the PR). */
function gateFail(msg: string): never {
	if (process.env.GITHUB_ACTIONS === "true") { console.log(`::error title=Silo capability gate::${msg.replace(/\n/g, "%0A")}`); }
	console.error(`\n  ✗ ${msg}`);
	process.exit(1);
}

/** `silo [dir] [--approve]` — the two-sided safety baseline (own code + node_modules). Arms as a
 *  non-interactive gate when `CI` is set (GitHub Actions et al.), e.g. `CI=true silo audit`: never
 *  writes/approves; fails on un-approved drift or unreviewed capability-bearing changes. The drop-in
 *  for the Silo GitHub Action. */
async function baseline(args: string[], consumerOnly = false) {
	const ci = /^(1|true)$/iu.test(process.env["CI"] ?? "");   // CI gate arms off $CI — there is no `--ci` flag
	const approve = !ci && args.includes("--approve");
	const target = args.find((a) => !a.startsWith("--")) ?? PROJECT;   // default: the resolved root
	const self = consumerOnly ? "silo audit" : "silo";
	const fresh = !fs.existsSync(BASELINE);
	const b = loadBaseline();

	// The QUALITY axis's two human gestures — both per-unit ledger entries, hash-anchored (NOT a global
	// counter that merges wrong). Neither is `--approve`: accepting a capability fingerprint is a different
	// affirmation from "I read this code". --reviewed = I read it; --waive = I did NOT and I'm taking it anyway.
	const waiving = args.includes("--waive");

	if (waiving || args.includes("--reviewed")) {
		const marked = await markReviewed(args.find((a) => !a.startsWith("--")) ?? PROJECT, waiving);

		console.log(marked.length
			? `  ✓ ${waiving ? "WAIVED (accepted unread)" : "reviewed"}: ${marked.map((u) => u.id).join("\n              ")}`
			: "  no such unit");

		return;
	}

	// FAMILY-C ESCALATION: cooldown left a breadcrumb that deps moved since the last approve. Reframe this
	// run as "review the new surface" and clear it once handled (below). Ignored under CI — there the drift
	// check IS the gate, and the marker is just noise from the workflow's own install step.
	const pending = ci ? null : readPending();

	console.log(`▶ ${self}${ci ? " (CI gate)" : ""} — ${PROJECT}\n`);
	if (pending) {
		const moved = pending.lockBefore ? `${pending.lockBefore} → ${pending.lockAfter}` : pending.lockAfter;

		console.log(`  ⚠ dependencies changed — ${pending.reason} on ${pending.at.slice(0, 10)} (lock ${moved}).`);
		console.log(`    Reviewing the new capability surface below; re-approve (\`${self} --approve\`) if it's expected.\n`);
	}
	if (ci && fresh) { gateFail(`no committed baseline — expected .silo/baseline.json. Run \`${self}\` locally and commit it.`); }

	// Compute the QUALITY axis once; auditConsumer joins it per-dep-row, then we print the spectrum + ratchet.
	const review = reviewUnits();
	const exposed = new Set<string>();
	const drift = (await auditConsumer(b, target, fileStates(review), exposed)) + (consumerOnly ? 0 : await auditPackages(b));

	await flushFingerprints();   // both audits fed the cache — persist once
	printReview(review);

	// The ratchet: what did THIS CHANGE touch that reaches a dangerous capability and hasn't been read?
	const base = baseRef();
	const gated = gateUnits(review, exposed, touchedUnits(base));

	console.log(`\n  trust — quality axis  (vs ${base})`);
	if (!gated.length) {
		console.log("    no unreviewed capability-bearing units touched by this change");
	} else {
		console.log(`    ${gated.length} capability-bearing unit(s) touched but NOT reviewed:`);
		for (const u of gated) { console.log(`      ${u.understood === "stale" ? "◐" : "○"} ${u.id}`); }
	}

	// Deltas get noticed where snapshots go numb; a PR annotation is dismissed in front of people.
	const summary = process.env["GITHUB_STEP_SUMMARY"];
	const trustLine = `**silo trust** — ${gated.length} unreviewed capability-bearing unit(s) touched by this change`;

	if (summary) { await fs.appendFile(summary, trustLine + "\n"); }
	if (process.env["GITHUB_ACTIONS"] === "true" && gated.length) { console.log(`::notice title=Silo trust::${trustLine.replace(/\*/gu, "")}`); }

	if (ci) {
		if (drift) { gateFail(`${drift} un-approved capability change(s) vs .silo/baseline.json. If intended, run \`${self} --approve\` locally and commit the updated baseline.`); }
		if (gated.length) {
			gateFail(`trust ratchet: this change touched ${gated.length} capability-bearing unit(s) you haven't read:\n${gated.map((u) => `      ${u.id}`).join("\n")}\n    Review them (\`silo --reviewed <file>#<fn>\`), or take the debt knowingly (\`silo --waive <file>#<fn>\`) — a waiver is recorded as "accepted without reading".`);
		}

		console.log("\n  ✓ no capability drift, no unreviewed capability-bearing changes — baseline holds");

		return;
	}

	// Each "handled" exit clears the Family-C marker; un-approved drift (below) deliberately KEEPS it, so the
	// dep change keeps escalating until you review + approve it.
	if (fresh) { await saveBaseline(b); if (pending) { await clearPending(); } console.log(`\n  ✓ baseline written to .silo/baseline.json — commit it; re-run gates drift.`); return; }

	// `--approve` persists the CAPABILITY fingerprints and nothing else — the quality axis's state lives
	// per-unit in the review ledger, so there is no aggregate to approve.
	if (approve) { await saveBaseline(b); if (pending) { await clearPending(); } console.log("\n  ✓ capability baseline approved — baseline updated"); return; }

	if (drift) { console.log(`\n  ⚠ ${drift} un-approved change(s). Review, then \`${self} --approve\`.`); process.exit(1); }
	if (pending) { await clearPending(); console.log("\n  ✓ dependencies changed, but your capability surface is unchanged — nothing to re-review."); return; }
	console.log("\n  ✓ no drift — baseline holds");
}

// CLI surface via @brianjenkins94/util/cmd (cmd-ts). silo's shape is two structured subcommands
// (`audit`, `status`) + a DEFAULT (bare / flags-only → the two-sided baseline) + a script CATCH-ALL
// (`silo <path>` → run), which cmd-ts's strict subcommands don't model — so the structured subcommands
// go through cmd-ts and the rest is routed by hand. There is no `--ci` flag: the gate arms off `$CI`.
const app = group("silo", {
	"status": command({ "name": "status", "args": {}, "handler": async () => { status(); } }),
	"audit": command({
		"name": "audit",
		"args": {
			"dir": positional({ "type": optional(string), "displayName": "dir" }),
			"approve": flag({ "long": "approve" })
		},
		"handler": async ({ dir, approve }) => baseline([...(dir ? [dir] : []), ...(approve ? ["--approve"] : [])], true)
	})
});

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd.startsWith("-")) { await baseline(argv); }                  // bare `silo` / `silo --approve` (CI gate when $CI is set)
else if (cmd === "install" || cmd === "i") { installCmd(argv.slice(1)); }   // passthrough → cooldown install
else if (cmd === "status" || cmd === "audit") { await runCli(app, { "argv": argv, "exit": false }); } else { await run(cmd, argv.slice(1)); }   // `silo <script> [args…]` → the runner
