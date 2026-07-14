// Test JUDICIAL judge: allow fs:read and net:localhost, deny everything else.
let input = "";

process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
	let req = {};

	try { req = JSON.parse(input); } catch {}
	const allow = /^(fs:read:|net:localhost)/.test(req.scope || "");

	process.stdout.write(JSON.stringify(allow ? { "behavior": "allow" } : { "behavior": "deny", "message": "judge-denied" }));
});
