// fetch URL — gated by the broker's fetch override (host-level). No catch: a denied gate propagates.
await fetch(process.env.URL);
console.log("NET-OK");
