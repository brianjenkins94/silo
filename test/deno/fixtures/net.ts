// Native fetch routed to the broker's `net` → net scope.
await fetch(Deno.env.get("URL")!);
console.log("NET-OK");
