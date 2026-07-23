# Design: drop the `version` setting, track the latest Deno release

· Status: **implemented** in this PR (`deno.dang`, `deno-project.dang`,
`deno-workspace.dang`, e2e, `README.md`) and verified against `main` — all 15 e2e
checks pass; `version` reports the latest release and a `base` override is
honoured. The `deno.mdx` rewrite (§6) is a companion change for `dagger/dagger`.
**Gated on engine:** self calls need [dagger/dagger#13693](https://github.com/dagger/dagger/pull/13693),
which is on `main` but in no release yet — so `engineVersion` and the repo's CI
engine must move to a release carrying it before merge. 
· Supersedes: [#2](https://github.com/dagger/deno/pull/2) — *automatic Deno version bumps* (closed unmerged) 
· Touches: `deno.dang`, `deno-project.dang`, `deno-workspace.dang`, `README.md`,
and `docs/current_docs/modules/deno.mdx` in `dagger/dagger`

---

## 1. Problem

The module pins its toolchain with a literal string:

```dang
pub version: String! = "2.9.3"

pub base: Container! = container.from("denoland/deno:alpine-" + version)
```

That string goes stale the day Deno cuts a release. [#2](https://github.com/dagger/deno/pull/2)
proposed keeping it fresh with machinery — a `Maintenance` module that reads
denoland/deno's git tags, a weekly GitHub Action, a bot PR, a `DAGGER_CLOUD_TOKEN`
secret, `contents: write` + `pull-requests: write` permissions. It works, but:

- it's a lot of moving parts to maintain a single string;
- the string is duplicated (`deno.dang`, `README.md`, `deno.mdx`), so the bump has
  to rewrite prose;
- it only helps **this repo**. Anyone who installed the module gets a fresh
  default only after we cut a release *and* they re-pin the dependency.

We closed #2 in favour of resolving "latest" at call time, in the module itself.

## 2. Goal

Remove the `version` setting entirely. The default toolchain is **the latest
published Deno image**, resolved by the engine and refreshed at most once a week.
`base` stays as the escape hatch for anyone who wants an exact pin.

## 3. Mechanism

Two engine features combine into a rolling pin:

1. **`@cache(ttl:)`** — a Dang function can declare a result TTL. The directive
   compiles to `withCachePolicy(Default, timeToLive:)`
   ([`core/sdk/dang/v2/helpers.go`](https://github.com/dagger/dagger/blob/main/core/sdk/dang/v2/helpers.go#L572),
   example usage in
   [`test-directives/main.dang`](https://github.com/dagger/dagger/blob/main/core/integration/testdata/modules/dang/test-directives/main.dang#L64)).
2. **Self calls** — a module can call its own API rather than inlining the call.
   This is the part that matters: a plain local call (`latestImage`) is
   evaluated inline by the Dang interpreter and **never touches the function
   cache**. Only a call routed through the API is a cached function call, and it
   is written against the module's **type name** — `Deno.latestImage`, *not* the
   lowercase constructor `deno`. (This bit me for several rounds: `deno.latestImage`
   fails with `Error: "deno" not found`; `Deno.latestImage` resolves.)

So: put the bare image pull in a `@cache`d function, and reach it through a self
call from a *function body*. `container.from("denoland/deno:alpine")` resolves
the mutable tag to a digest once; the engine then serves that same resolved
`Container` for the TTL. Everyone on that engine builds against one digest for a
week, then it rolls forward on its own.

The cached function stays a *bare* pull so its cache key is nothing but "the
latest alpine image"; the `.withoutEntrypoint` / `DENO_NO_UPDATE_CHECK` tweaks
are layered on *outside* it (in `toolchain` below) so a future tweak never
becomes a cache-shape change.

`ttl: "168h"` (7 days) is also `MaxFunctionCacheTTLSeconds`
([`core/modfunc.go`](https://github.com/dagger/dagger/blob/main/core/modfunc.go#L26)),
the implicit cap on `Default`-policy results — so we're stating the maximum
explicitly rather than raising it.

### Status: verified working, with one shape constraint

#13693 is merged. Tested against `main` (@ `1862b24f`) with **the real deno
module** and a standalone repro, both on this repo's exact setup —
`dagger-module.toml`, `[runtime] source = "dang"`, `dang-sdk` installed via
`[…as-sdk]`. Self calls **work**; no experimental flag, no legacy `dagger.json`.
Two things had to be right:

1. **Call the type, not the constructor.** `Deno.latestImage` resolves;
   `deno.latestImage` fails with `Error: "deno" not found`. Earlier rounds of
   this doc were wrong to conclude self calls were disabled — that was this typo.
2. **Resolve in a body, never in a field default.** A self call in a `=` default
   (`pub base: Container! = Deno.latestImage…`) hangs indefinitely when the field
   is *read* — the self call re-enters module construction, which re-evaluates
   `base`'s default, which self-calls again: a read-time loop. (The module still
   *loads* fine; only reading that field hangs.) The fix is to keep the setting
   free of self calls and resolve in a computed field, which is exactly §4.1.

   Why today's `base` is fine and this isn't: today's default is
   `= container.from("denoland/deno:alpine-" + version)…` — a `=` settable field
   whose expression is a **builtin** (`container`), inlined, no self call, so it
   neither loops nor loses its override. The loop only appears when the default
   becomes "latest via the cache", i.e. a **self call**. At that point you can't
   keep both properties in one field: a `=` default self-call loops, and a
   computed-field `{ }` (the only self-call-safe home) isn't overridable. Hence
   the split — settable `base`, self-call in `toolchain`.

Verified end to end on `main`:

| shape | result |
|---|---|
| `pub base: Container! { Deno.latestImage.withoutEntrypoint }` (computed field) | ✅ returns a container, but **not overridable** |
| `pub base: Container = null` + `toolchain { base ?? Deno.latestImage… }` | ✅ returns latest when unset, **overridable** |
| `pub base: Container! = Deno.latestImage…` (field default) | ❌ hangs on read |

The computed-field form (top row) is the shortest and is what the repro used, but
a computed field is read-only: with `base = "…debian…"` in settings the override
is **silently ignored** (still resolves the body's alpine), and there's no
`--base` flag (`unknown flag: --base`) — both verified. Only a *settable* field
gets a setting and a `--base` flag, and a settable field can't self-call in its
default (row 3 hangs). So §4.1 keeps `base` a plain nullable setting and moves the
self call into `toolchain` (middle row): with the same `base = "…debian…"` setting
it correctly resolves debian, unset resolves alpine.

## 4. Proposed implementation

### 4.1 `deno.dang`

A self call can't live in a field default (blocker #1), so `base` becomes a
**nullable setting** — unset means "track latest" — and the resolution happens in
a `toolchain` computed field, which is where the self call is legal. Self calls
are written against the **type name** (`Deno.latestImage`). The self-call and
computed-field forms below are the ones **verified on `main`** (§3).

```dang
type Deno {
  """
  Override the container Deno commands run in — an exact pin
  (`docker.io/denoland/deno:alpine-2.9.3`) or your own image (it must have `deno`
  on PATH, or pass it through `install` first). Unset (the default) tracks the
  latest published denoland/deno:alpine, re-resolved at most once a week.
  """
  pub base: Container = null

  """
  The container every verb builds on: the override if set, otherwise the latest
  image with our defaults layered on. A computed field, not a field default, so
  the `Deno.latestImage` self call runs when the field is read — a self call in a
  `=` default hangs on read (see §3).
  """
  let toolchain: Container! {
    base ?? Deno.latestImage
      .withoutEntrypoint
      .withEnvVariable("DENO_NO_UPDATE_CHECK", "1")
  }

  """
  The latest published Deno image, cached for a week. `denoland/deno:alpine` is
  a mutable tag; holding the resolved digest for the TTL means every command in
  the workspace runs against one Deno build for a week before rolling forward.

  Deliberately a bare pull — no entrypoint or env tweaks — so the cache key is
  nothing but "the latest alpine image". `toolchain` layers our defaults on top.
  """
  @cache(ttl: "168h")
  pub latestImage: Container! {
    container.from("denoland/deno:alpine")
  }

  """
  The `deno` binary from the latest published denoland/deno:bin image. Same
  rolling-pin treatment as `latestImage`.
  """
  @cache(ttl: "168h")
  pub latestBinary: File! {
    container.from("denoland/deno:bin").file("/deno")
  }

  pub install(ctr: Container!): Container! {
    ctr
      # 493 == 0o755; Dang has no octal literals.
      .withFile("/usr/local/bin/deno", Deno.latestBinary, permissions: 493)
      .withEnvVariable("DENO_DIR", "/deno-dir")
      .withMountedCache("/deno-dir", cacheVolume("deno-cache"))
  }

  """
  The Deno release the toolchain actually runs, e.g. "2.9.3".
  """
  pub version: String! {
    let out = toolchain.withExec(["deno", "--version"]).stdout
    (out.split("\n")[0] ?? "").split(" ")[1] ?? ""
  }

  # ... project / workspace / *All verbs unchanged, minus the `version:` argument
}
```

`version` survives as a **read-only report** (the mdx already documents it as
"prints the configured toolchain version"), not as a setting. It's derived from
`toolchain`, so it stays correct whether `base` is overridden or tracking latest.

`project` / `workspace` pass **`toolchain`** (the resolved `Container!`) into
`DenoProject` / `DenoWorkspace` where they used to pass `base`. The self call
resolves once, in `Deno`, and the members receive a plain container — they never
self-call, so nothing changes on their side beyond the field they store.

### 4.2 `deno-project.dang` / `deno-workspace.dang`

Delete `let version: String!`, `numGte`, and `supportsPermissionSets`, and drop
`version:` from every constructor call (the `base` field they already take now
carries the resolved `toolchain` container). `test` and `compile` then always
send `-P`:

```dang
pub test(ws: Workspace!): Void @check {
  container(ws).withExec(["deno", "test", "--permit-no-files", "-P"]).sync
  null
}
```

The `-A` fallback existed only because a caller could set `version` below 2.5.0.
With `version` gone, the default is always the latest release, which always
supports config-file permission sets. The residual case — someone overrides
`base` with a pre-2.5.0 image — becomes a documented requirement rather than
runtime branching.

> Alternative considered: keep the fallback and derive the version from the
> container (`deno --version`) instead of a setting. Rejected — it adds an exec
> to the critical path of every `test`/`compile` to support an image nobody
> should be choosing. If we're wrong, the fallback comes back keyed on
> `version()`.

### 4.3 Pinning, for people who need it

`base` becomes the single, exact pin:

```bash
dagger settings deno base docker.io/denoland/deno:alpine-2.9.3
```

```toml
[modules.deno.settings]
base = "docker.io/denoland/deno:alpine-2.9.3"
```

## 5. Honest limits

- **The function cache is per engine.** Two machines, or two ephemeral CI
  engines, can resolve different digests inside the same week. This is a
  *freshness* control, not a lockfile. Say so in the docs, and point strict
  reproducibility at `base`.
- **Cold CI engines resolve latest every run.** For a throwaway engine per job,
  the TTL buys nothing — each run gets whatever is current.
- **A Deno release can break a workspace with no commit.** It surfaces as a
  `dagger check` failure with no diff to blame. The remedy is one setting
  (`base`), and the blast radius is bounded by the TTL rather than being
  instantaneous. This is the trade we're accepting in exchange for deleting the
  bump machinery.

## 6. Work items

**`dagger/deno`** — done in this PR

- [x] `deno.dang`: removed `pub version`; `base` is a nullable setting
      (`Container = null`); added `toolchain` (`base ?? Deno.latestImage…`),
      `latestImage` + `latestBinary` (`@cache(ttl: "168h")`, bare pulls);
      `install` uses `Deno.latestBinary`; read-only `version` off `toolchain`;
      verbs and members build on `toolchain`. Self calls use the **type name**
      `Deno.…`.
- [x] `deno-project.dang`, `deno-workspace.dang`: dropped `version` / `numGte` /
      `supportsPermissionSets`; take the resolved `toolchain` container in place
      of `base`; `test` and `compile` always use `-P`.
- [x] `README.md`: dropped the `version` setting / 2.5.0 fallback / `--version`
      example / `deno(version:)`; reframed the toolchain as latest-tracking,
      pinnable via `base`; pointed the engine requirement at `--x-release=main`.
- [x] e2e: replaced `legacyVersionCheck` with `versionCheck` (asserts a real 2.x
      release + a working `latestImage`); nothing asserts a literal version.

- [ ] **Before merge:** bump `engineVersion` (`dagger-module.toml`,
      `.dagger/modules/e2e`) and the repo CI engine to a release that carries
      #13693. None exists yet — this is the merge gate.

**`dagger/dagger`** — companion PR (not applied here; local checkout is on an
unrelated branch)

- [ ] `docs/current_docs/modules/deno.mdx`. Replace the whole "Configure it"
      section with:

      > ## Configure it
      >
      > By default the toolchain tracks the **latest** published Deno release,
      > re-resolved at most once a week. No configuration is required. To pin an
      > exact release, set `base` — with `dagger settings deno base <ref>`, or in
      > `dagger.toml`:
      >
      > ```toml
      > [modules.deno.settings]
      > base = "docker.io/denoland/deno:alpine-2.9.3"
      > ```
      >
      > Permissions still come from each project's `deno.json`; that needs Deno
      > ≥ 2.5.0, so only override `base` with a 2.5.0+ image.

      Drop the `version` bullet, the `dagger settings deno version 2.9.3` snippet,
      the `version = "2.9.3"` TOML, and the "`base` and `version` are mutually
      exclusive" line. In the closing paragraph, change "`version` prints the
      configured toolchain version" to note `version` *reports* the toolchain's
      Deno release and `toolchain` (not `base`) is the ready-to-use container.

## 7. Verified against `main` @ `1862b24f`

Tested with the **real deno module** (`dagger-module.toml`, `dang` runtime,
`dang-sdk` via `[…as-sdk]`) and a standalone repro — no experimental flag:

1. **Self calls work with `dagger-module.toml`** — using the type name.
   `Deno.latestImage` resolves; `deno.latestImage` fails `"deno" not found`. The
   earlier "self calls need the legacy flag" conclusion was a typo, now retracted.
2. **`base ?? Deno.latestImage…` in a computed field returns the latest image**
   when `base` is unset. This is §4.1's shape, run end to end.
3. **A `=` field default with a self call hangs on read.** The module loads, but
   reading that field never returns — so `base` cannot be a `= self-call` default;
   it has to be a plain setting resolved in `toolchain`.
4. **A nullable `base: Container = null` is fully overridable.** `--base <ref>`
   and `[modules.<mod>.settings] base = …` both flow through `toolchain`.
   (Settings only apply when the module is invoked by its workspace name, e.g.
   `dagger call deno …` — not via an ad-hoc `-m <path>` load.) So unset → latest,
   set → the pin.
5. **The implemented module passes end to end.** All **15 e2e checks** green on
   `main`; `deno version` → `2.9.3` (parsed from the self-called toolchain);
   `deno --base docker.io/denoland/deno:alpine-2.5.0 version` → `2.5.0` (override
   honoured); `install` produces a working `deno` from `latestBinary`.

Still open (behaviour tuning, not blockers):

6. **Is the TTL honoured across calls?** Confirm two calls a minute apart reuse
   one resolved digest, and the cached `Container` carries the pinned digest
   rather than re-resolving `denoland/deno:alpine` downstream.
7. **`denoland/deno:alpine` and `:bin` are the right mutable tags** for "latest
   stable" (vs `:latest`, `:distroless`).
8. **Is 7 days the right TTL,** or is 24h better given the per-engine caveat (§5)?
