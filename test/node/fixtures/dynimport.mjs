// Reach node:fs via DYNAMIC import() — the static bundle can't see this, but the preload's
// registerHooks load-hook still intercepts it. Write is gated like a static import.
const fs = await import("node:fs");

fs.writeFileSync(process.env.TARGET, "x");
console.log("DYN-WROTE");
