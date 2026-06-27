# NOTES — Silo design history, rationale, and gotchas

The *why*, the *history*, the *non-goals*, and the gotchas behind the prototype. `README.md` is the
polished design doc; this file holds what would otherwise be rediscovered the hard way. Silo was
extracted from the `ok-claude` repo, where it grew out of a "how do I trust AI-generated scripts?"
question and was dogfooded on that project's `scripts/refresh.ts`.

> The Silo scripts are themselves unproven AI-generated prototypes — fittingly, exactly the kind of
> thing Silo exists to track.

---

## Goals & non-goals

**Goal:** make trust in a script *earned* (confidence from run history) and *bounded* (capability
permissions), so AI-generated/unproven scripts can run and earn trust without being a leap of faith.

**Non-goals (important):**
- **Not** an adversarial sandbox. Silo does honest-drift detection + least-privilege, not defense
  against code *actively hiding* what it does (obfuscation, `globalThis[x]`, dynamic `eval`). That's a
  different, much harder problem. The right framing: "exercise suspicion on a package *changing its
  needs*," not "prevent targeted badness."
- **Not** the npm *supply-chain* problem — i.e. *package-intrinsic* "is this package safe?" (whole-code,
  transitive, adversarial; LavaMoat / SES / Compartments territory, strictly harder). Silo's per-*script*
  model is per-process (≈ Deno). We *did* later extend to the consumer↔package boundary (`silo audit`),
  but that's the **consumer-relationship** half ("is my usage of this dep still what I approved?"), not
  the package-intrinsic one. See "the npm extension" below.
- **Not** a formatter/linter. A linter codifies *style*; Silo codifies *capability + provenance*. They
  catch different layers (lint wouldn't have caught any of the real bugs hit while building this).

---

## How the idea evolved (so you don't re-tread it)

1. "How do I distinguish AI-generated, unproven code from my trusted code?" → first answer was a
   **banner** (`AI-GENERATED:unproven`) + a convention. Rejected as a *claim* you must remember to remove.
2. "Better: codify my expectations" → ESLint/Biome discussion. Real but only the *style* layer.
3. "What I really want is a script manager" → run history, success rate, revision history, a
   **confidence score**, and **Deno-style permission prompts**.
4. The npm tangent (per-package import permissions) — concluded it's the harder, separate problem; the
   *script* version is the tractable one (coarse enforcement works, honest-drift, few of them).
5. "Capability should be per-function/export, not per-file" → settled on **export as the unit, computed
   via the call graph** (function-level reachability). Then **entry rooting** so the script's `main`
   (non-exported) is also analyzed.
6. "Scope it" → net at **domain**, fs at **folder** → led to runtime interception (the resolved scope
   is what static can't pin).
7. "Shims that don't just observe but prompt" + "bundle before executing" → the **bundle-injected
   enforcing broker** (`instrument.ts` + `capability-broker.mjs`). Net (async prompt), fs/exec (sync prompt).
8. Consolidated into `cli.ts`. Named **Silo**.
9. **Revisited the npm tangent** (step 4) and found the *consumer* half is tractable: not "what can the
   package do" (intrinsic) but "what do *I* use from it, and did that drift?" Built it as `silo audit` —
   a member-level **surface** (oxc AST) × **capability** (rolldown DCE) join, drift-gated.
10. **Deobfuscation** — real npm ships bundled/minified dist (esbuild `__commonJS` thunks) that hide caps
    from DCE; added a webcrack ∪ wakaru stage that recovers them (the two fail on orthogonal axes).
11. **Browser** — the same engine runs client-side (`web/`, GitHub-Pages-deployable) via esm.sh +
    in-browser deobfuscation, sharing the `capability-detectors.ts` core with the CLI.

---

## Key design decisions & rationale

- **Two engines, on purpose.** `static-caps-lsp` (LSP call hierarchy) is type-precise and gives the call
  *path*, but **under-reports** when types don't resolve (dangerous bias) and is blind to property
  reads. `static-caps-dce` (vite tree-shaking / DCE) **over-reports** (conservative-keep — the *safe* bias)
  and needs no types. Running both and surfacing disagreements = the unresolved/blind-spot detector.
- **tsgo / TS compiler API over ts-morph** — a deliberate preference. tsgo's LSP is viable today
  (advertises `callHierarchyProvider`). ttsc/ts-patch is for build-time *transforms*, not standalone
  analysis, and would foreclose tsgo — skip it for the engine.
- **Static + runtime, merged.** Static = "what it *can* do" (gate-time, complete-ish). Runtime broker =
  "what it *did*, and where" (precise scopes, partial coverage). Neither alone is enough; the dry-run
  path of a script exercises *no* capabilities, which is why static reachability is required.
- **Confidence = churn-decayed Wilson lower bound.** Real runs weigh 1.0, dry-runs 0.25, stale-sha runs
  decay. This makes "earned trust" behave: dry-runs alone stay `unproven` (correct — the apply path
  never actually ran). A capability/import *expansion* re-gates; an edit decays.
- **Bundling as the injection point.** It's a *userland retrofit* (no engine/TC39 support needed) and
  the only place to wrap builtin *named imports* uniformly. The broker is the enforcement broker, not
  just a logger.

**Lesson from a reverted extraction:** pulling shared helpers into their own module earns its keep only
with a *second* consumer. A single-consumer extraction was built and then collapsed back inline.

---

## Hard-won technical gotchas

- **tsgo LSP:** launch `tsgo --lsp -stdio`. callHierarchy is **call-based** → misses property reads
  (`process.env`). Attributes calls to the **enclosing function** → must recurse into nested closures
  (e.g. `fetch` living under an inner arrow). **Under-reports unresolved symbols** → needs a `tsconfig`
  resolving `@types/node` or capabilities silently vanish.
- **esbuild:** filters use **Go regex (RE2)** — no `u` flag (`/…/u` fails). Virtual modules (custom
  namespace) need `resolveDir` set in `onLoad` or imports won't resolve. `platform: "node"` auto-
  externalizes builtins. To wrap a builtin: `onResolve` → custom namespace, `onLoad` → generate a
  module that gets the *real* builtin via `createRequire(import.meta.url)("node:fs")` (bypasses the
  rewrite) and re-exports wrapped capability fns + passes the rest through.
- **macOS `/tmp` is a symlink to `/private/tmp`** → breaks entry guards like
  `import.meta.url === \`file://${process.argv[1]}\`` (resolved vs literal). Invoke with the realpath,
  or compare realpaths. (The boxer deliberately writes its temp entry under `/private/tmp`.)
- **Sync prompts:** `fs.readSync(0, …)` reads stdin synchronously (for gating sync builtins like
  `writeFileSync`). Works against a TTY/direct pipe, but **stdin does not pass through a nested
  `spawnSync` with `stdio:"inherit"`** in a non-interactive harness — so first-run grants couldn't be
  exercised in CI (they work interactively; persistence is wired).
- **vite DCE:** `process.env` rewriting is fixable with `define: { "process.env": "process.env" }`
  (identity).

---

## The npm extension (consumer↔package) — what we built

Step 4 punted on "per-package permissions" as the harder, separate problem. It *is* — but it conflated
two questions. **Package-intrinsic** ("is this package safe?" — whole-code, transitive, adversarial) is
the hard LavaMoat/SES one. **Consumer-relationship** ("what do *I* import & use from it, and has that
drifted?") is the same earned/bounded/honest-drift model Silo already had, with the trust boundary moved
to the import edge. That second half is `silo audit`.

**Shape:** a bipartite fingerprint per dependency — **surface** (which members my code touches; Axis A,
`import-surface.ts`, oxc AST) × **capability** (what that slice reaches; Axis B, `package-capabilities.ts`,
rolldown DCE) — joined so a cap delta points at an interface delta. Drift is a diff on either axis: hold
version fixed → *I* changed; hold surface fixed → the *package* changed under me.

**esm.sh is useful but NOT an analysis substrate.** Its *transformed* output is wrong for static analysis
in both directions: minification collapses `fs:read`/`fs:write` (UNDER-reports) and its DCE leaves
dangling `node:` imports (OVER-reports), and its esbuild CJS-interop thunks defeat a second-pass
tree-shake (re-DCE drops real `fs`). So for static analysis use **raw source** — the npm tarball (CLI) or
jsdelivr/unpkg (browser-fetchable raw files) — *not* esm.sh `?raw` (strictly dominated). **Sourcemaps are
forgeable** (attacker-controlled JSON, no integrity link to the `.js` that runs) → cosmetic-only, never
the verdict. Gotcha: esm.sh defaults to a *browser* target that shims away `node:` builtins — pin
`?target=node` if you do read its output.

**Deobfuscation (for bundled dist) — webcrack ∪ wakaru, no zenfs.** A large fraction of npm ships a
pre-bundled `dist/`, so "the tarball is clean source" is often false. webcrack (Babel) un-thunks
esbuild/obfuscator.io output; wakaru unpacks bundler module formats. They fail on **orthogonal axes** —
webcrack owns *obfuscation depth* (string-arrays, control-flow-flattening = the malware case), wakaru
owns *bundler breadth* (SystemJS/AMD/UMD/Bun) — so we **union** their recovered caps (validated: esbuild's
own `exec`, hidden behind a `__toESM` thunk, is recovered only after deobfuscation). No filesystem
polyfill (zenfs) is needed: webcrack detects the browser (`isBrowser()` → `createBrowserSandbox`) and its
`fs`/`isolated-vm` imports are dead code there; the bundler just had to be told to **stub** them.

**Browser parity.** The dependency engine runs entirely client-side (`web/`) and shares the exact
`capability-detectors.ts` core + union rule with the CLI (verified: identical caps whole-package on
picocolors/tinyglobby/esbuild). The real divergences are **not** "vite vs rolldown" (vite 8 *is* rolldown,
and the browser runs no local DCE): **source** (installed tarball vs esm.sh rebuild — provenance),
**granularity** (CLI per-member slice vs browser whole-package), **wakaru build** (`@wakaru/cli` native vs
`@wakaru/unpacker` JS). Bundling webcrack/wakaru for the browser needed: polyfill the builtins they touch
at init (`process`, `path.posix`, `Buffer`), **stub** the ones they never reach (`node:fs/promises`,
`isolated-vm`), and `@originjs/vite-plugin-commonjs` for unpacker's mixed-ESM `require("assert")`.

**Where the old tangent still holds (package-intrinsic):** the "per-package import-level permissions"
dream (`import x with { permissions }`) is years out (Compartments → ShadowRealm). **LavaMoat**
(SES/Compartments) is today's shipping approximation; **Deno** has per-process/Worker permissions;
**Socket.dev** does "this version added net/fs/shell" via *static* analysis (proof the honest-drift model
is commercially viable). Silo's bundle-time **fingerprint + diff + TOFU** is the lightweight, local,
consumer-side version — it can *decide and instrument*, not *enforce* without SES or real isolation
underneath. (Worker-isolation + SAB/Atomics could enforce per-package without SES — a scalpel for a few
risky packages, not a blanket.)

---

## Open threads / next steps

Per-script (runner):
- Add the `env`/property-read pass (LSP `references` on `process`).
- Flag-on-unresolved (treat an unresolved callee as "assume capability").
- Fix the first-run grant stdin-through-`spawnSync` (or have `cli` prompt directly).
- A Deno enforcement backend (translate the scoped fingerprint → `--allow-*`).
- Transitive import policy (no `left-pad` *anywhere*, via the DCE bundle's external set).
- Replace the hardcoded illustrative `POLICY` in `cli.ts` with a config file.

Per-dependency (audit) + browser:
- **Scope-resolve the surface** — `import-surface.ts` matches binding names within a file (v1), so a
  local shadowing an import name is mis-attributed (rare, over-reports). v2: tsgo LSP `references` or
  oxc-semantic.
- **Per-member slicing on bundled deps** — bundled-dist caps are currently whole-bundle (safe
  over-approx); re-DCE'ing the *deobfuscated* output rooted at members is proven possible, not yet wired.
- **Runtime/sandbox pass** — execute a package in a real sandbox (node Worker+SES / browser realm) to
  catch *import-time* side-effects that static DCE structurally misses (the node-ipc/peacenotwar case).
- **wakaru-in-browser** — currently `@wakaru/unpacker` (JS lib); the fast native `@wakaru/cli` is CLI-only.
- A VSCode view (thin client over `cli … --json`) — the one piece of the original plan never started.
