/**
 * Integration: the Deno WRAPPER-ENTRY (silo-deno.mjs). Native caps still flow to the broker; this asserts
 * the codegen layer Deno can't permission — eval / Function / AsyncFunction — is gated, while clean code
 * runs. Run with: deno test -A test/deno/
 */
import assert from "node:assert/strict";
import { runUnderBroker, FIXTURE, SILO_DENO } from "./_helpers.mjs";

// JUDICIAL=allow so the wrapper + its imports (read perms) load; codegen denial comes from the wrapper.
const viaWrapper = (fixture, env = {}) =>
	runUnderBroker([SILO_DENO, FIXTURE(fixture)], { env: { JUDICIAL: "allow", ...env } });

Deno.test("clean code runs through the wrapper", async () => {
	const r = await viaWrapper("clean.ts");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /CLEAN 6/);
});

for (const MODE of ["eval", "fn", "asyncfn"]) {
	Deno.test(`codegen denied: ${MODE}`, async () => {
		const r = await viaWrapper("codegen.ts", { MODE });
		assert.notEqual(r.code, 0, `${MODE} should be denied`);
		assert.match(r.stderr, /BERNARD redline eval/);
		assert.doesNotMatch(r.stdout, /CODEGEN/);
	});
}
