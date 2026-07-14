// Write then read back TARGET. Both calls are capability-bearing (write + read) and get gated.
import { readFileSync, writeFileSync } from "node:fs";

const p = process.env.TARGET;

writeFileSync(p, "silo");
console.log("FS-WROTE", readFileSync(p, "utf8"));
