// Native subprocess routed to the broker's `run` → exec scope. BIN, ARGS (JSON).
const cmd = new Deno.Command(Deno.env.get("BIN")!, { args: JSON.parse(Deno.env.get("ARGS") || "[]") });
await cmd.output();
console.log("RAN");
