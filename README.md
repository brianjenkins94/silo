# silo

**Earned, bounded trust for scripts.** Silo fingerprints what a script *can do*, enforces it with a
bundle-injected broker that prompts before anything new, and scores how much the script has been
*proven* by its run history — so an unproven (e.g. AI-generated) script is **boxed, gated,
drift-watched, and scored** instead of just dropped into your codebase next to your trusted code.

> Status: **prototype.** Extracted from the `ok-claude` repo, where it was dogfooded on that
> project's `scripts/refresh.ts`. This is the design doc + working prototype.

Silo applies that model at **two boundaries**: the **scripts you run** (fingerprint → box → broker →
confidence — everything below) and the **dependencies you import** (`silo audit`: a member-level
*surface* → *capability* → *drift gate*). Same earned/bounded/honest-drift philosophy, pointed at your
relationship with each npm package — and the dependency engine also runs **in the browser** (`web/`,
GitHub-Pages-deployable).

## Why

AI-generated scripts accrete into a codebase indistinguishable from vetted code. The usual fix —
mark them "unproven" — is a *claim* you have to remember to peel off. Silo makes trust:

- **earned** — a confidence score that *rises* with successful runs and *decays* when the code changes;
- **bounded** — a script can only touch capabilities you've approved; anything new stops and asks
  (Deno-style "stop before doing the thing").

So "let an unproven script run and earn trust" becomes safe: the cost of running it is bounded by the
grant, and its proven-ness is a number, not a vibe.

## Setup

```sh
npm install
```

Installs the dev dependencies: **tsgo** (`@typescript/native-preview`, the static engine's LSP),
**esbuild** (the boxer), **rolldown/vite** (DCE engines), **oxc-parser** (the consumer-surface AST),
**webcrack** + **wakaru** (deobfuscating bundled dependencies), and **tsx** (to run the `.ts` tools
directly — no build step). The browser build (`web/`) adds the **vite** plugins
`vite-plugin-node-polyfills` and `@originjs/vite-plugin-commonjs`.

## Usage

```sh
# per-script trust (the runner)
npx tsx cli.ts <script> [args…]   # fingerprint + import policy → drift gate → box + execute
npx tsx cli.ts ls                 # managed scripts: capabilities, approved scopes, confidence

# per-dependency trust (the audit)
npx tsx cli.ts audit [dir]        # member surface → capability per dep → drift gate (exit 1 on drift)
npx tsx cli.ts audit . --approve  # accept the current dependency surface as the baseline
```

## Two layers of capability analysis

- **Static — *what it can reach.*** Drive **tsgo's LSP call hierarchy**: root at every top-level
  function (including the non-exported entry `main`), walk `outgoingCalls` recursively, and classify
  each callee by its **definition file** (`fs.d.ts` → `fs:read`/`fs:write`, `child_process.d.ts` →
  `exec`, `lib.dom` `fetch` → `net`). Type-precise, complete-ish (all paths), and yields the call path.
  (An alternate engine uses vite tree-shaking / DCE for reachability — a safer over-approximating bias.)
- **Runtime — *what it actually reaches, and where.*** A broker injected into the bundle intercepts
  capability calls and gates the **resolved scope** (`net:localhost:3000`, `fs:write:/path`) against an
  allowlist, prompting on anything new. Precise scopes, but only for paths that run.

Static says what it *can* do; runtime refines to where it *did* — and a newly-observed scope outside
what's approved is the flag.

## Components

Entry + shared core:

| file | role |
|---|---|
| `cli.ts` | the `silo` entry point — dispatches `audit`, the per-script runner, and `ls`. |
| `capability-detectors.ts` | shared capability detectors (the regex core) used by both halves. |

`runner/` — per-script earned/bounded trust (the original prototype):

| file | role |
|---|---|
| `runner/static-caps-lsp.ts` | static engine via tsgo LSP call hierarchy. `--json` for machine output. |
| `runner/static-caps-dce.ts` | alternate static engine via tree-shaking (DCE reachability). |
| `runner/import-policy.ts` | import prohibition — denylist of specifiers (e.g. ban `left-pad`, or prefer a wrapper). |
| `runner/instrument.ts` | bundle a script with the broker injected + `node:fs`/`node:child_process` rewritten to brokered wrappers. |
| `runner/capability-broker.mjs` | enforcing broker — gates `net` (async prompt), `fs`/`exec` (sync prompt); allowlist + persisted grants. |

`audit/` — per-dependency capability audit (the npm-boundary extension):

| file | role |
|---|---|
| `audit/import-surface.ts` | member-level consumer surface — what your code imports & uses per dependency. |
| `audit/package-capabilities.ts` | what a dependency's used slice can reach (DCE + deobfuscation). |
| `audit/deobfuscate.ts` | un-thunk / un-minify bundled deps (webcrack + wakaru) before detection. |

## The runner

```sh
run <script> [args…]   # fingerprint + import policy → drift gate → box + execute
                        # under the broker → persist grants → score
run ls                 # managed scripts: capabilities, approved scopes, confidence
```

Each run computes a fingerprint (content hash + imports + static caps), checks import policy, gates on
**drift** (a new capability/import is TOFU-prompted), **boxes** the script (broker + builtin
rewriting), executes it with the broker's allowlist seeded from the registry's **approved scopes**,
persists any new grants, appends to the run ledger, and updates confidence.

State (generated, git-ignored): a registry (`registry.json` — per-script fingerprint +
approved scopes), a run ledger (`runs.jsonl`, append-only), and the boxed bundle per script.

## The dependency audit (`silo audit`)

Where the runner governs *scripts you write*, `audit` governs *dependencies you import* — the
consumer↔package boundary. It joins two axes, per dependency:

- **Surface — *what you use.*** `audit/import-surface.ts` does member-level binding analysis (oxc AST):
  which exports of each dependency your code actually imports and calls (`import * as _; _.get(…)` →
  member `get`; computed/dynamic access → `*`). Resolved to `pkg@version`.
- **Capability — *what that reaches.*** `audit/package-capabilities.ts` bundles the *used slice* with
  rolldown DCE and detects what it can do (`fs:read`/`fs:write`, `exec`, `net`, `eval`, `env`).
  Builtins map directly; a dependency that ships **bundled/minified** dist is deobfuscated first
  (`audit/deobfuscate.ts` — webcrack ∪ wakaru) so thunked code doesn't silently drop caps.

The join (`member → capability`) is diffed against an approved baseline (`deps.json`). A new member —
or the strongest signal, a **new capability** (`fs:read` gaining `fs:write`) — is un-approved drift;
`audit` **exits non-zero** on drift (so it gates a commit/CI), and `--approve` accepts the current
surface. This is honest-drift at the *interface*: not "is this package safe?" (the package-intrinsic
supply-chain problem) but "is my relationship to this package still the one I approved?"

## Browser

The dependency engine also runs **entirely client-side** (`web/`, a Vite app — no server,
GitHub-Pages-deployable). It fetches a package's pre-built bundle from esm.sh, deobfuscates it in the
browser (webcrack ∪ `@wakaru/unpacker`), and runs the **same** `capability-detectors.ts` core as the
CLI. The CLI stays the authoritative, provenance-faithful path (installed source + per-member DCE);
the browser is the coarser, zero-install "what can package X do?" explorer. The detection core and
union rule are shared; the divergences (source, slice granularity, wakaru build) are spelled out in
[NOTES.md](NOTES.md).

## Confidence

A **Wilson lower bound** over weighted runs: real (`--apply`) runs weigh `1.0`, dry-runs `0.25`, and
runs at a now-stale content hash decay. So: 0 runs → `unproven`; clean real runs climb it; an edit
decays it; a capability/import expansion re-gates. A script with only dry-runs stays `unproven` no
matter how many — which is the point.

## Scoping & enforcement

- **Net** is gated at **domain** granularity, **fs** at **folder** granularity, **exec** at **binary** —
  the resolved scope is matched against an allowlist; a miss prompts and (on approval) persists.
- Scopes map directly onto **Deno permissions** (`--allow-net=host`, `--allow-write=folder`), so a Deno
  (or OS-sandbox) backend is the natural path to enforcement stronger than the in-process broker.
- A target that can't be pinned statically (an env-driven URL, a param path) is `*` — a first-class
  signal that the reach is indeterminate and needs a broad grant.

## Status — proven vs. open

**Proven (per-script):** static fingerprint (entry rooting, read/write granularity, call paths); import
policy; drift gate; the enforcing broker (net domain prompt, fs/exec folder/binary **sync** prompt on
the real resolved scope; allow / grant / deny); allowlist seeded from approved scopes; churn-decayed
confidence.

**Proven (per-dependency, `silo audit`):** member-level consumer surface (named/default/namespace +
member access, computed → `*`); slice-scoped capability via rolldown DCE; builtin→capability mapping;
deobfuscation of bundled dist (webcrack ∪ wakaru, validated to recover caps esbuild thunks otherwise
hide); surface→capability join + drift gate (exits non-zero); the **same** engine running in the
browser with parity on the detection core.

**Open / known gaps:**
- **`env` / property-read caps** — call hierarchy is call-based, so `process.env` (a property read) is
  invisible; needs a complementary LSP `references` pass.
- **Flag-on-unresolved** — tsgo *under-reports* when types don't resolve (no edge for an unresolved
  callee); a real impl must treat an unresolved call as "assume capability / flag" and run against a
  typed program (a `tsconfig` resolving `@types/node`).
- **First-run interactive grant** — the broker's sync prompt works against a TTY; in a non-interactive
  harness, stdin doesn't pass through the nested `spawnSync` (the grant-persistence path is wired and
  demonstrated by pre-seeding approved scopes).
- **Enforcement backend** — the broker is in-process; Deno or an OS sandbox would be a stronger box.
- **Surface shadowing** — `audit/import-surface.ts` matches binding names within a file, so a local
  variable shadowing an import name is mis-attributed (rare, and over-reports — the safe direction).
  v2 is scope-resolved references (tsgo LSP or oxc-semantic).
- **Browser is coarser** — the web path analyzes esm.sh's rebuild whole-package (no per-member slice)
  with the JS `@wakaru/unpacker`; the CLI (installed source + per-member DCE + native wakaru) is the
  authoritative one.

See [NOTES.md](NOTES.md) for the design history, rationale, and hard-won gotchas.
