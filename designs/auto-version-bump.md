# Design: automatic Deno version bumps

· Status: **implemented** — `.dagger/modules/maintenance` + `.github/workflows/bump-deno-version.yml`
· Scope: keep the module's **default** Deno version current, automatically and safely

## 1. Goal

The module pins a default Deno version for reproducibility
([`deno-module.md`](./deno-module.md) §5). It lives in one place:

```dang
# deno.dang
pub version: String! = "2.1.4"
```

`install` and `base` derive the image tags (`denoland/deno:alpine-<version>`,
`denoland/deno:bin-<version>`) from it, so this literal is the **single source of
truth** (the `README.md` also shows it in a few illustrative examples). We want:
when Deno ships a new stable release, open a PR that bumps the default — verified
green — with no manual toil. Pinning stays; we automate the bump.

## 2. Why not Dependabot

Dependabot updates **recognized manifests** per ecosystem (npm, docker,
github-actions, gomod, …). Our default is a **string literal in a `.dang` source
file** — no ecosystem parses it. There is no "Deno runtime" ecosystem; the
Deno-adjacent support that exists targets `deno.json` *imports* (a project's
dependencies), not a module's own default-version constant. Contorting it (a
decoy `Dockerfile` for the `docker` ecosystem, synced into the Dang literal) just
creates a second source of truth. So: a purpose-built job, not Dependabot.

## 3. The bump: a Dagger-native function

Do the bump *in Dagger* — the logic is then testable locally, reuses the
changeset-preview model, and keeps brittle logic out of YAML. Add a small
maintenance module at `.dagger/modules/maintenance` (mirroring
`.dagger/modules/e2e`), installed with the `deno` module as a dependency:

```graphql
type Maintenance {
  "Latest stable Deno release (e.g. \"2.1.4\"), from the denoland/deno git tags."
  latestDenoVersion: String!

  """
  Bump the module's default Deno version and return the diff. Rewrites the
  `version` default in deno.dang and the illustrative versions in README.md.
  Defaults to the latest stable release.
  """
  bumpDenoVersion(ws: Workspace!, version: String! = ""): Changeset!
}
```

Sketch:

```dang
type Maintenance {
  pub latestDenoVersion: String! {
    git("https://github.com/denoland/deno").tags
      .filter { t => t.containsMatch(`^v\d+\.\d+\.\d+$`) }   # stable only, no pre-releases
      .map { t => t.trimPrefix("v") }
      .reduce("0.0.0") { max, v => if (semverGt(v, max)) { v } else { max } }
  }

  pub bumpDenoVersion(ws: Workspace!, version: String! = ""): Changeset! {
    let target = if (version == "") { latestDenoVersion } else { version }
    let before = ws.directory("/", include: ["deno.dang", "README.md"])

    let current = currentDefault(before)
    let after = before
      .withFile("deno.dang", rewriteDefault(before.file("deno.dang"), target))
      .withFile("README.md", replaceVersion(before.file("README.md"), current, target))

    after.changes(before)
  }
  # currentDefault: regex-read `pub version: String! = "X"` from deno.dang
  # rewriteDefault: regex-replace that literal with `target`
  # replaceVersion: swap the old version string for the new in README examples
  # semverGt: compare two "X.Y.Z" strings numerically (small helper)
}
```

Notes:

- **Not a `@generate`.** A version bump is network-dependent and non-idempotent,
  which violates the module's own "no-arg, idempotent generator" rule
  ([`deno-module.md`](./deno-module.md) §3) — you don't want it firing on every
  `dagger generate`. It's a plain, explicitly-invoked function that *returns* a
  `Changeset`; callers apply it with `dagger -y call …` or via the preview prompt.
- **Latest resolution is native** (`git(...).tags`) so there's no GitHub API
  auth/User-Agent/rate-limit dance. The CI job may still pass `--version`
  explicitly (e.g. resolved by `gh`) if we ever prefer that.
- **README stays in sync**: `bumpDenoVersion` rewrites both `deno.dang` and the
  `README.md` examples in the same changeset.
- Local use / testing: `dagger call maintenance latest-deno-version`,
  `dagger call maintenance bump-deno-version` (preview), `dagger -y … ` (apply).

## 4. CI: a scheduled workflow

A weekly (and manually dispatchable) job runs the bump, verifies it, and opens a
rolling PR. It uses the official [`dagger/dagger-for-github`](https://github.com/dagger/dagger-for-github)
action so we don't hand-roll engine setup, and sources the engine version from
`dagger-module.toml` instead of hard-coding it.

```yaml
name: bump-deno-version
on:
  schedule: [{ cron: "0 6 * * 1" }]   # Mondays 06:00 UTC
  workflow_dispatch: {}
permissions:
  id-token: write     # Dagger Cloud auth via GitHub OIDC token
  contents: write     # create-pull-request pushes the bump branch
  pull-requests: write # create-pull-request opens the PR
jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # The module targets a beta engine; read the pin so the action installs the
      # matching CLI (which provisions the matching engine) rather than duplicating it.
      - id: engine
        run: echo "version=$(sed -n 's/engineVersion = "\(.*\)"/\1/p' dagger-module.toml)" >> "$GITHUB_OUTPUT"

      # Apply the bump to the working tree (auto-apply the returned changeset).
      - uses: dagger/dagger-for-github@v8.4.0
        with:
          version: ${{ steps.engine.outputs.version }}
          verb: call
          module: ./.dagger/modules/maintenance
          call: bump-deno-version
          dagger-flags: "-y"
          cloud-token: ${{ secrets.DAGGER_CLOUD_TOKEN }}

      # Verify: the e2e suite runs on the *default* version, so this gates both
      # "images published" and "tests pass" (see §5).
      - uses: dagger/dagger-for-github@v8.4.0
        with:
          version: ${{ steps.engine.outputs.version }}
          verb: check
          cloud-token: ${{ secrets.DAGGER_CLOUD_TOKEN }}

      # Only reached if verify passed. No diff -> no PR.
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/bump-deno-version
          title: "chore: bump default Deno version"
          commit-message: "chore: bump default Deno version"
          labels: dependencies, automated
          signoff: true
          body: |
            Automated bump of the module's default Deno version, verified with
            `dagger check` (the e2e suite runs on the default version).
```

- **One rolling PR** on a fixed branch — updated in place, no spam if several
  releases land between runs.
- **No auto-merge.** A maintainer reviews and merges. (`peter-evans` supports
  auto-merge; we deliberately don't enable it.)
- If the verify step fails, the job fails and **no PR is opened** — next week's
  run (or a manual dispatch) retries. A red run is the signal for a genuine
  breakage (e.g. a new Deno version that changes lint rules).

## 5. Verification is (almost) free

`.dagger/modules/e2e` drives the module with `deno()` — the **default** version.
So `dagger check` after the bump:

- **fails if the new tag's images aren't published yet** (`container.from(
  "denoland/deno:alpine-<v>")` errors — common in the hours after a release), and
- **fails if the new Deno breaks** lint / test / fmt / type-check on the samples.

One gate covers both "images exist" and "still works" — no separate image probe.

## 6. Decisions & edge cases

- **README sync: yes** — the bump rewrites `deno.dang` and `README.md` together.
- **Auto-merge: no** — always human-reviewed.
- **Major bumps** (e.g. `2.x → 3.x`): the verify gate catches functional breakage;
  the PR is labeled and left for review like any other. No special-casing needed
  given no auto-merge.
- **Image lag / pre-releases:** `latestDenoVersion` filters to stable `vX.Y.Z`
  tags; the verify gate handles not-yet-published images (skip-and-retry).
- **Several releases between runs:** we jump straight to the newest — fine.
- **Cadence:** weekly is ample (Deno patches ~monthly); `workflow_dispatch` covers
  "bump now".
- **Engine pin:** sourced from `dagger-module.toml` and fed to the action's
  `version:` input, so it installs the pinned CLI directly (which provisions the
  matching engine). The beta is on the normal release channel
  (`dl.dagger.io/dagger/releases/<v>/`), so no `--x-release` flag is needed — the
  installed CLI *is* the target engine.

## 7. Locked decisions

- **Dagger Cloud traces: yes.** The job passes `cloud-token: ${{
  secrets.DAGGER_CLOUD_TOKEN }}` (as in §4); add the `DAGGER_CLOUD_TOKEN` repo
  secret.
- **Tag resolution in Dang: yes.** `latestDenoVersion` uses `git(...).tags` with a
  small semver-max helper — no `gh`/API dependency in the workflow.
</content>
