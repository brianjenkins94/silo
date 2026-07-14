// Run BIN with ARGS (JSON). a[0]=BIN is the exec scope the broker gates on.
import { execFileSync } from "node:child_process";

const out = execFileSync(process.env.BIN, JSON.parse(process.env.ARGS || "[]"), { "encoding": "utf8" });

console.log("EXEC-RAN", out.trim());
