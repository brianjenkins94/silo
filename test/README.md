# Silo test suite

Built-in runners, zero extra deps: **`node --test`** for `test/node/`, **`deno test`** for `test/deno/`.

```sh
npm test            # node suite then deno suite
npm run test:node   # node --test "test/node/*.test.mjs"
npm run test:deno   # deno test -A test/deno/
```

(`node --test` here needs an explicit glob, not a bare directory.)

## Entrypoints under test

| Entrypoint | What it is | Suite |
| --- | --- | --- |
| `decide.mjs` | shared decision core (`redline` + `judicial`) | `node/decide.test.mjs` |
| box runner | `cli.ts run` → `instrument.ts` bundles the broker in | `node/box.test.mjs` |
| `--import` preload | `preload.mjs` registerHooks on the real files | `node/preload.test.mjs` |
| Deno permission broker | `deno-broker.mjs` socket; Deno enforces, silo decides | `deno/broker.test.mjs` |
| Deno wrapper-entry | `silo-deno.mjs` gates codegen Deno can't permission | `deno/codegen.test.mjs` |

## Gates under test

- **redline** — credentials/git/system-dir writes, dangerous exec bins, `net:*`, `eval`; plus the `BERNARD` env extension.
- **JUDICIAL** — `ask`/unset → fallback, `allow`, `deny`, command (spawns a judge); bad output fails closed.
- **codegen** — `eval`, `Function`, `AsyncFunction`, `GeneratorFunction` (incl. the `.constructor` escape hatch).
- **fs** read/write, **exec**, **net(fetch)** — allowlist vs JUDICIAL vs BERNARD redline (fail-closed, no TTY).
- **dynamic `import()`** — caught by the preload's load hook (the static bundle can't see it).
- **Deno mapping** — `read/write/net/run` → silo scopes; redline; coarse `run` (see below).

## Known asymmetry (a real finding, encoded in the tests)

Deno's permission-broker `run` query carries **`value: null`** — it does *not* tell the broker which binary
is being spawned (whereas `net` carries `host:port`). So under Deno, `exec` is a **coarse** all-or-nothing
gate decided by JUDICIAL; the per-binary redline (e.g. block `rm` specifically) only works in the **Node**
broker, where `execFileSync`'s first arg gives the binary. `deno/broker.test.mjs` asserts the coarse
allow/deny accordingly.

## Not yet covered

- CLI dispatch routing (`ls` / `baseline` / `audit` / bare) and baseline/drift gating — needs a fixture
  repo + installed `node_modules` (capsOf fetches package source), so it's slower/heavier.
- Interactive TTY prompt paths (`askSync`/`askAsync`, BERNARD break-glass *success*) — need a pty; tests
  exercise the non-TTY fail-closed path and the JUDICIAL/allowlist paths instead.
