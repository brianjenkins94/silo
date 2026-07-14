/**
 * silo — earned, bounded trust for scripts and dependencies. This is the command layer: it wires the
 * subcommands and orchestrates `baseline`, which joins the two axes —
 *   • CAPABILITY (audit.ts) — what your code and deps CAN do, vs a committed baseline.
 *   • QUALITY    (review.ts) — how much of the capability-bearing code you've actually READ.
 *
 *   silo                      the two-sided baseline (own code + node_modules) + the trust ratchet
 *   silo audit                consumer side only
 *   silo <script> [args…]     fingerprint → gate → box → execute under the broker (runner.ts)
 *   silo ls                   list managed scripts
 *   silo install [args…]      cooldown-aware install
 *   silo --reviewed <unit>    sign off a unit (I read it) · --waive <unit> (accepted unread)
 */
import * as fs from "@brianjenkins94/util/fs";
import { command, flag, group, optional, positional, run as runCli, string } from "@brianjenkins94/util/cmd";
import { auditConsumer, auditPackages, type Baseline, loadBaseline, saveBaseline } from "./audit.js";
import { flushFingerprints } from "./cache.js";
import { BASELINE, PROJECT } from "./paths.js";
import { baseRef, fileStates, markReviewed, printReview, reviewUnits, type Scored, touchedUnits } from "./review.js";
import { installCmd, ls, run } from "./runner.js";

/** Fail the gate. In GitHub Actions also emit a workflow error annotation (shows inline on the PR). */
function gateFail(msg: string): never {
	if (process.env.GITHUB_ACTIONS === "true") { console.log(`::error title=Silo capability gate::${msg.replace(/\n/g, "%0A")}`); }
	console.error(`\n  ✗ ${msg}`);
	process.exit(1);
}

// THE TRUST RATCHET, diff-scoped: every capability-bearing unit THIS CHANGE TOUCHED must be reviewed (or
// consciously waived). Not "you have debt" (people disable that within a week) — "you made it worse". And
// no stored count: an aggregate merges to a silently-wrong number when two devs each add one; git already
// holds the history, so ask it. Diff-scoping is also fairer (you answer only for what you touched).
/** Units this change touched that reach a dangerous capability and are neither reviewed nor waived. */
function gateUnits(review: Scored[], exposed: Set<string>, touched: Set<string>): Scored[] {
	return review.filter((u) => touched.has(u.id) && exposed.has(u.file) && u.understood !== "reviewed" && u.understood !== "waived");
}

/** `silo` / `silo baseline [dir] [--approve|--ci]` — the two-sided safety baseline (own code + node_modules).
 *  --ci: non-interactive gate for CI — never writes/approves; fails on un-approved drift or unreviewed
 *  capability-bearing changes. The drop-in for the Silo GitHub Action. */
async function baseline(args: string[], consumerOnly = false) {
	const ci = args.includes("--ci");
	const approve = !ci && args.includes("--approve");
	const target = args.find((a) => !a.startsWith("--")) ?? PROJECT;   // default: the resolved root
	const cmd = consumerOnly ? "audit" : "baseline";
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

	console.log(`▶ silo ${cmd}${ci ? " --ci" : ""} — ${PROJECT}\n`);
	if (ci && fresh) { gateFail(`no committed baseline — expected .silo/baseline.json. Run \`silo ${cmd}\` locally and commit it.`); }

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
		if (drift) { gateFail(`${drift} un-approved capability change(s) vs .silo/baseline.json. If intended, run \`silo ${cmd} --approve\` locally and commit the updated baseline.`); }
		if (gated.length) {
			gateFail(`trust ratchet: this change touched ${gated.length} capability-bearing unit(s) you haven't read:\n${gated.map((u) => `      ${u.id}`).join("\n")}\n    Review them (\`silo --reviewed <file>#<fn>\`), or take the debt knowingly (\`silo --waive <file>#<fn>\`) — a waiver is recorded as "accepted without reading".`);
		}

		console.log("\n  ✓ no capability drift, no unreviewed capability-bearing changes — baseline holds");

		return;
	}

	if (fresh) { await saveBaseline(b); console.log(`\n  ✓ baseline written to .silo/baseline.json — commit it; re-run gates drift.`); return; }

	// `--approve` persists the CAPABILITY fingerprints and nothing else — the quality axis's state lives
	// per-unit in the review ledger, so there is no aggregate to approve.
	if (approve) { await saveBaseline(b); console.log("\n  ✓ capability baseline approved — baseline updated"); return; }

	if (drift) { console.log(`\n  ⚠ ${drift} un-approved change(s). Review, then \`silo ${cmd} --approve\`.`); process.exit(1); }
	console.log("\n  ✓ no drift — baseline holds");
}

// CLI surface via @brianjenkins94/util/cmd (cmd-ts). silo's shape is subcommands + a DEFAULT (bare /
// flags-only → baseline) + a script CATCH-ALL (`silo <path>` → run), which cmd-ts's strict subcommands
// don't model — so the structured subcommands go through cmd-ts and the rest is routed by hand.
function gate(consumerOnly: boolean) {
	return command({
		"name": consumerOnly ? "audit" : "baseline",
		"args": {
			"dir": positional({ "type": optional(string), "displayName": "dir" }),
			"approve": flag({ "long": "approve" }),
			"ci": flag({ "long": "ci" })
		},
		"handler": async ({ dir, approve, ci }) => baseline([...(dir ? [dir] : []), ...(approve ? ["--approve"] : []), ...(ci ? ["--ci"] : [])], consumerOnly)
	});
}

const app = group("silo", {
	"ls": command({ "name": "ls", "args": {}, "handler": async () => { ls(); } }),
	"audit": gate(true),
	"baseline": gate(false)
});

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd.startsWith("-")) { await baseline(argv); }                  // bare `silo` / `silo --approve` / `--ci`
else if (cmd === "install" || cmd === "i") { installCmd(argv.slice(1)); }   // passthrough → cooldown install
else if (cmd === "ls" || cmd === "audit" || cmd === "baseline") { await runCli(app, { "argv": argv, "exit": false }); } else { await run(cmd, argv.slice(1)); }   // `silo <script> [args…]` → the runner
