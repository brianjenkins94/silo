// Demo consumer code for the Silo capability gate. Its committed .silo/baseline.json records that this
// project's capability surface is exactly { node:fs → fs:read }. Add an import that reaches a NEW
// capability (e.g. node:child_process → exec) and `CI=true silo audit` fails — try it in a PR.
import { readFileSync } from "node:fs";
import * as path from "node:path";

const pkg = readFileSync(path.join(import.meta.dirname, "package.json"), "utf8");

console.log("ci-demo read", JSON.parse(pkg).name);
