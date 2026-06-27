// Native fs op routed to the broker. MODE=read|write, TARGET=path.
const p = Deno.env.get("TARGET")!;
if (Deno.env.get("MODE") === "read") console.log("READ", (await Deno.readTextFile(p)).length);
else { await Deno.writeTextFile(p, "silo"); console.log("WROTE"); }
