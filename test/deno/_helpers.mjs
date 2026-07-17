/** Deno integration helper: start the Node deno-broker on a throwaway socket, run a `deno run …` target
 *  with DENO_PERMISSION_BROKER_PATH pointed at it (so Deno routes every permission check to silo), then
 *  tear it all down. Returns { code, stdout, stderr } of the target. */
const ROOT = new URL("../../", import.meta.url).pathname;
const BROKER = ROOT + "enforce/deno-broker.mjs";
export const SILO_DENO = ROOT + "enforce/silo-deno.mjs";
export const FIXTURE = (n) => new URL("./fixtures/", import.meta.url).pathname + n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForSock(p, ms = 4000) {
	const t = Date.now();
	while (Date.now() - t < ms) { try { Deno.statSync(p); return true; } catch { await sleep(30); } }
	return false;
}

/** Run `deno run <denoArgs…>` under a fresh broker. `env` is applied to BOTH processes: the decider keys
 *  (JUDICIAL/BERNARD) are read by the broker, the fixture keys (MODE/TARGET/BIN/…) by the Deno target. */
export async function runUnderBroker(denoArgs, { env = {} } = {}) {
	const id = crypto.randomUUID().slice(0, 8);
	const sock = `/tmp/silo-test-${id}.sock`;
	const grants = `/tmp/silo-test-${id}.grants.json`;
	try { Deno.removeSync(sock); } catch { /* fresh */ }
	const broker = new Deno.Command("node", {
		args: [BROKER, sock],
		env: { ...Deno.env.toObject(), DENO_GRANTS: grants, ...env },
		stdout: "null", stderr: "null",
	}).spawn();
	try {
		if (!(await waitForSock(sock))) throw new Error("broker did not start (no socket)");
		const out = await new Deno.Command("deno", {
			args: ["run", ...denoArgs],
			env: { ...Deno.env.toObject(), DENO_PERMISSION_BROKER_PATH: sock, ...env },
			stdout: "piped", stderr: "piped",
		}).output();
		const dec = new TextDecoder();
		return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
	} finally {
		try { broker.kill("SIGKILL"); } catch { /* already gone */ }
		try { await broker.status; } catch { /* */ }
		try { Deno.removeSync(sock); } catch { /* */ }
		try { Deno.removeSync(grants); } catch { /* */ }
	}
}
