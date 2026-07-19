/** @jsxImportSource preact */
import reviewJson from "silo:review";
import workspace from "silo:workspace";
import { createVscodeWindow } from "./vscode";

// Mount the monaco workbench full-page on a snapshot of the silo repo itself (baked in at build time
// by siloWorkspacePlugin — the git working tree minus node_modules/docs). So the hosted page opens on
// real source, not a fixture, not blank.
//
// `silo review --json` is baked in too (siloReviewPlugin) and written as `.silo/review-units.json`, which
// the silo extension reads via workspace.fs to drive the review overlay (decorations + CodeLens).
const REVIEW_UNITS = "/silo/.silo/review-units.json";
const files = [...workspace.filter((f) => f.path !== REVIEW_UNITS), { "path": REVIEW_UNITS, "contents": reviewJson }];

createVscodeWindow({
	"workspaceFolder": "/silo",
	"files": files,
	"openEditors": ["/silo/commands/review.ts"],
	"onSave": (path, contents) => { console.log("[saved]", path, contents.length + " bytes"); }
});
