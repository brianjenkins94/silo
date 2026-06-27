/**
 * Shared CODEGEN interceptor — one place that overrides every dynamic-codegen entry point so all three
 * enforcement surfaces (the box, the --import preload, the Deno wrapper-entry) gate eval the same way.
 *
 * Covers eval + new Function AND the hidden AsyncFunction / GeneratorFunction / AsyncGeneratorFunction
 * constructors — which have NO global binding (only reachable via (async()=>{}).constructor), so a plain
 * globalThis.Function override misses them, and even plain Function leaks through (function(){}).constructor.
 * We gate each via its prototype's `constructor`, closing that escape hatch.
 *
 * The DECISION stays per-backend: pass a gate(scope) that returns on allow and THROWS on deny (the broker
 * routes through BERNARD/JUDICIAL with a TTY; the Deno shim has no TTY so redline just fails closed).
 */
export function installCodegenGate(gate) {
	const scopeOf = (src) => "eval:" + String(src).replace(/\s+/g, " ").slice(0, 60);

	const realEval = globalThis.eval;
	globalThis.eval = (s) => { gate(scopeOf(s)); return realEval(s); };

	// Wrap a codegen constructor so both call and `new` gate first. The Proxy forwards .prototype reads,
	// so instanceof stays intact; Reflect.construct preserves newTarget for subclassing.
	const gateCtor = (Ctor) => new Proxy(Ctor, {
		apply: (t, self, a) => { gate(scopeOf(a.join(","))); return Reflect.apply(t, self, a); },
		construct: (t, a, nt) => { gate(scopeOf(a.join(","))); return Reflect.construct(t, a, nt); },
	});

	const CTORS = [
		[globalThis.Function, true],                                       // Function (also a global)
		[Object.getPrototypeOf(async function () {}).constructor, false],  // AsyncFunction
		[Object.getPrototypeOf(function* () {}).constructor, false],       // GeneratorFunction
		[Object.getPrototypeOf(async function* () {}).constructor, false], // AsyncGeneratorFunction
	];
	for (const [Ctor, isGlobal] of CTORS) {
		const gated = gateCtor(Ctor);
		if (isGlobal) globalThis.Function = gated;
		Object.defineProperty(Ctor.prototype, "constructor", { value: gated, writable: false, enumerable: false, configurable: true });
	}
}
