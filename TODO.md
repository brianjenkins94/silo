# TODO

Where the silo ⇄ lib (`@brianjenkins94/util`) migration was left off.

## 🟨 Written but NOT verified (blind — needs a real run)

- **`util-publish` generalizations** (root/single-package, skip-private, `cwd` root, `NPM_TOKEN` publish,
  declared-bin preservation, `.mjs` shipping). Couldn't run it locally — lib's vite build yak-shawed. The
  **first lib release + first silo release will shake these out.**
  - 🐛 **FIXED 2026-06-29**: lib CD run 28345953022 was green but `publish.ts` actually **crashed** at the
    `.mjs/.cjs` glob — `TypeError: entry.includes is not a function`. With `withFileTypes: true` the glob
    `exclude` callback gets a **Dirent**, not a string; the `node_modules` check assumed a string. Fixed by
    normalizing entry→path first. (publish.sh has no `set -e`, so the crash didn't fail the job — it just
    skipped rebuilding `util`, leaving Pages on stale `util@0.18.0` and orphaning the `util@0.19.0` draft.)
    **NEXT: commit lib + re-run `gh workflow run cd.yml -R brianjenkins94/lib`** → ships 0.19.0 with
    `cmd.js` + `findWorkspaces` + `scripts/publish.js`. THAT is what unblocks silo (real `./cmd`, drop the
    overlay) and silo's own `npx util-publish` release.
  - 🛡️ **Hardened so a crash can't go green again — WITHOUT blocking the packages that DID build** (the
    real lesson: CI shell scripts swallowed non-zero exits, but the original `catch { continue }` was
    *intentional* so a partial failure still published the rest). Final shape:
    - `publish.ts`: `catch` records the failed package (loud `console.error`), keeps building the others,
      then at the end sets `process.exitCode = 1` (NOT `process.exit` — that would truncate the successes'
      in-flight tarball/npm writes).
    - `publish.sh`: **no `set -e`** (it would abort the resilient promotion loop). Captures
      `pnpm run publish || PUBLISH_STATUS=$?`, promotes every package that produced a fresh tarball, then
      `exit $PUBLISH_STATUS` at the very end → red run, successes still promoted.
    - `cd.yml`: `upload-pages-artifact` step + `deploy` job both `if: ${{ !cancelled() }}` so the
      successes' tarballs still deploy to Pages even though the publish job ends red.
    - No `set -eo pipefail` anywhere (explicit `PUBLISH_STATUS` capture is clearer and doesn't fight the
      resilient promotion loop). smoke.sh + the cd.yml tag step left as the originals.
- **silo consuming the *real* util** — right now it works via a hand-placed `cmd.js` overlay in
  `node_modules`; a `npm install` would wipe it until util is actually republished.

## ⬜ Still needs you / not done

- **Commit everything** — all changes across **silo, lib, and games** are uncommitted.
- **Republish `util`** via lib's CD (so silo gets the real `closest`/`cmd`/optional-peers).
- **Add the `NPM_TOKEN`** secret for silo's release.
- **First silo release** to validate the blind `util-publish` path.

## 🧩 Co-located subprojects + `private: true` (MOSTLY DONE 2026-06-28)

Goal: drop a subproject into the silo repo (e.g. a vscode-in-browser playground → Pages) without it
confusing the `silo` command. Decision: **`private: true` means "silo ignores this — everywhere."**

- ✅ **publish** skips `private` packages (`util-publish`).
- ✅ **audit** — `files()` in `analysis/import-surface.ts` now prunes *nested* private workspaces
  (`isPrivateWorkspace`), so `workspaceSurfaces`/`auditConsumer` skip them — BUT the audit *target* itself
  is never pruned, so `cd examples/ci-demo && silo audit` still works. Tested in `ci-gate.test.mjs` (two
  new cases: nested-private-ignored + private-target-still-governed).
- ✅ **build** — `util-publish` (`publish.ts`) now excludes nested-workspace dirs from a parent's source
  build (`isNested`, both the `.ts` and `.mjs/.cjs` globs), so silo's root tarball won't slurp a nested
  package (also fixes the latent `examples/ci-demo` slurp). ⚠️ still BLIND (vite build never runs locally).
- ⬜ nicety: `silo` run inside a private subproject should say "private — not silo-governed" rather than
  silently resolving up to silo's `.silo`. (Not done — low priority.)
- subproject carries its own `private` package.json + deps + vite build + its own Pages-deploy workflow.

### Propagate `private` upward — one discovery primitive (DONE 2026-06-28)

- ✅ **`findWorkspaces(cwd?)`** added to `lib/util/fs.ts`: `git ls-files */package.json */*/package.json`
  (kept the 1–2 level cap on purpose — lift only when a deeper layout exists) → read each →
  `{ dir, name, private }[]`. Functionally verified against the lib repo.
- ✅ **build.ts / postinstall.ts** consume it with `.filter(w => !w.private)`; **publish.ts** inherits the
  filter via `build()` and additionally excludes nested dirs from the source build (above).
- ✅ **cd.yml `list-packages` + `detect-changes/action.yml`** — the `git ls-files | jq` enumerators are now
  private-aware via an inline `while read … jq -r '.private'` filter. Deliberately NOT a `util-workspaces`
  bin: these run pre-install (before the matrix), so util isn't available yet — inline shell keeps CI
  self-contained. Both decode-verified against the running shell pipeline. ⚠️ lib-CI, unrun by me.
- ⬜ decide: does postinstall install private subprojects for dev, or do they self-install? (lean
  self-install — postinstall now simply skips them.)

## 🧬 AI-provenance heuristic (DONE 2026-06-29 — annotation only)

Identify likely AI-authored code; surface it as a trust signal on the audit. Heuristic basis (chosen by
user — the original phrase-list approach was scrapped as arbitrary/noisy):

- ✅ **`analysis/provenance.ts`** — two signals, no phrase-matching. (1) STRUCTURAL = doc-comment
  COVERAGE: the FRACTION of a file's functions/classes/methods carrying a non-JSDoc doc comment directly
  above them (any length — terse counts). Premise: AI documents nearly every function, humans selectively.
  (Evolution: phrase-list → big-prose-blocks → broadened-to-all-blocks [rejected, too blunt] → this.) JSDoc
  (`@param`/`@returns`) doesn't count → those authors undetectable (accepted). (2) `marker`:
  "Co-authored-by: Claude" / "AI-generated" in comments. Plus `gitCoauthoredFiles()` (AI-co-authored
  commits, merged by callers). Verdicts: likely = marker/git OR ≥70% documented; possible = ≥40%. No
  function-count floor — even a lone documented function reads AI (only a ZERO-function file can't be
  scored). CLI `tsx analysis/provenance.ts <file|dir> [--json] [--git]`. 8 unit tests.
  - 🐛 fixed: JSDoc-tag test was `/@\w+/`, which matched inline scoped-package mentions
    (`@typescript/native-preview`, `@brianjenkins94/util`) and wrongly exempted those comments as JSDoc →
    functions read undocumented. Now anchored to an `@tag` at comment-line-start. Regression-tested.
- ✅ **accepted limitation (settled)** — coverage on silo itself is 6 likely / 8 possible / 27 clean; of the
  27 clean, 18 have ZERO detected functions (script-style files / tiny fixtures) so a per-function-coverage
  signal can't score them. Only the top-of-file-docstring signal would reach those — considered & DECLINED.
  Coverage-only is the chosen model.
- ✅ **audit annotation** — `auditConsumer` (cli.ts) attributes drift to source files via
  `workspaceImporters()` (new export in import-surface.ts), merges `gitCoauthoredFiles(PROJECT)`, and
  appends `⚠ likely-AI` to any new-dep / capability-expansion line whose introducing file scores `likely`,
  plus a summary count. **Reporting only — never changes pass/fail.** 2 audit tests. Suite 37 green.
- ⬜ **opt-in gating** — the `--gate-ai` lever (make AI-introduced capability expansion a harder/explicit
  failure, vs. silent `--approve`). Deferred pending a decision on its exact semantics (see chat).
- 🔭 future signals (model is extensible): structural uniformity, per-block hotspots; possibly fold
  provenance into the baseline JSON so already-reviewed AI caps don't re-flag.
- ❌ lint-error density as a signal — considered & dropped: AI conforms to the repo's style guide when it's
  in context, so AI code tends to be *more* lint-clean, not less (signal likely inverted), and a formatter
  in CI erases it entirely. Not worth the linter infra for a weak/inverted tell.

## 🔭 Deferred (parked)

- **Per-workspace *policy* enforcement** — the audit now *attributes* caps per workspace; the next step is
  declaring/allowlisting caps per workspace (default-deny). Not started (parked on purpose).
- ~~`static-caps-lsp` consumer-coupling~~ — **done**: now anchors on the analyzed project (`PROJECT`), not
  silo's install dir, so transitive caps resolve in arbitrary repos.
