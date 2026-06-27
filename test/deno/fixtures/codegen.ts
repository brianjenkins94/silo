// Dynamic codegen — gated by silo-deno.mjs's wrapper (NOT a Deno permission). MODE=eval|asyncfn|fn.
const m = Deno.env.get("MODE");
let r: unknown;
if (m === "eval") r = eval("1+1");
else if (m === "asyncfn") r = await ((async () => {}).constructor as any)("return 2")();
else r = ((function () {}).constructor as any)("return 3")();
console.log("CODEGEN", m, r);
