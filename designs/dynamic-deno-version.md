# Design: drop the `version` setting, track the latest Deno release

· Status: **proposed** — #13693 merged, but now blocked on the `dang-sdk` module
enabling self calls (see §3, blocker #2) 
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
   This is the part that matters: a plain local call (`latestImage()`) is
   evaluated inline by the Dang interpreter and **never touches the function
   cache**. Only a call routed through the API (`deno.latestImage`) is a cached
   function call.

So: put the bare image pull in a `@cache`d function, and reach it through a self
call from a *function body*. `container.from("denoland/deno:alpine")` resolves
the mutable tag to a digest once; the engine then serves that same resolved
`Container` for the TTL. Everyone on that engine builds against one digest for a
week, then it rolls forward on its own.

The cached function stays a *bare* pull so its cache key is nothing but "the
latest alpine image"; the `.withoutEntrypoint` / `DENO_NO_UPDATE_CHECK` tweaks
are layered on *outside* it (in `toolchain()` below) so a future tweak never
becomes a cache-shape change.

`ttl: "168h"` (7 days) is also `MaxFunctionCacheTTLSeconds`
([`core/modfunc.go`](https://github.com/dagger/dagger/blob/main/core/modfunc.go#L26)),
the implicit cap on `Default`-policy results — so we're stating the maximum
explicitly rather than raising it.

### Status: two blockers, both found by testing against `main`

#13693 is merged (`main` @ `d813ed77`). Probing it with throwaway modules turned
the §7 open questions into hard facts — and surfaced a blocker the design didn't
anticipate:

1. **A self call in a field default recurses forever.** `pub base = deno.latestImage…`
   hangs indefinitely — even a call to an *unrelated* function hangs, so the
   default is evaluated **eagerly at construction**, and self-calling the `deno`
   constructor re-enters the constructor without end. This kills "keep `base`'s
   shape, just swap the pull". A self call has to live in a **function body**,
   evaluated at call time. §4.1 is rewritten around that.
2. **The `deno` SDK doesn't enable self calls, and TOML can't turn them on.**
   A self call from a function body works *only* under the built-in `dang` SDK
   with `experimental.SELF_CALLS: true` in a legacy `dagger.json`. This repo uses
   `github.com/dagger/dang-sdk` installed via `[…as-sdk]` on the new
   `dagger-module.toml`, where the whole `experimental` block is dropped
   (`toml:"-"`, commented "self-calls graduated"). Under that setup the self call
   fails inference — `Error: "probe" not found`. Enablement now flows only through
   the SDK advertising `AlwaysEnablesSelfCalls()`; the built-in Go `dangSDK` does,
   but the `dang-sdk` **module** does not. **This is the real gate** — until the
   `dang-sdk` module (or the engine's handling of it) enables self calls, none of
   this is buildable in `dagger/deno`, field default or not.

What *does* work (verified): `@cache(ttl:)` compiling to a real TTL, and a
self call from a function body under the built-in SDK returning a cached,
digest-pinned `Container`. The mechanism is sound; the packaging is blocked.

## 4. Proposed implementation

### 4.1 `deno.dang`

A self call can't live in a field default (blocker #1), so `base` becomes a
**nullable setting** — unset means "track latest" — and the resolution happens in
a `toolchain()` function body, which is where the self call is legal.

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
  image with our defaults layered on. A `let` function (not a field default) so
  the self call to `latestImage` is evaluated at call time, not at construction —
  a self call in a field default recurses forever (see §3).
  """
  let toolchain(): Container! {
    base ?? deno.latestImage
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
  pub latestImage(): Container! {
    container.from("denoland/deno:alpine")
  }

  """
  The `deno` binary from the latest published denoland/deno:bin image. Same
  rolling-pin treatment as `latestImage`.
  """
  @cache(ttl: "168h")
  pub latestBinary(): File! {
    container.from("denoland/deno:bin").file("/deno")
  }

  pub install(ctr: Container!): Container! {
    ctr
      # 493 == 0o755; Dang has no octal literals.
      .withFile("/usr/local/bin/deno", deno.latestBinary, permissions: 493)
      .withEnvVariable("DENO_DIR", "/deno-dir")
      .withMountedCache("/deno-dir", cacheVolume("deno-cache"))
  }

  """
  The Deno release the toolchain actually runs, e.g. "2.9.3".
  """
  pub version(): String! {
    let out = toolchain().withExec(["deno", "--version"]).stdout
    (out.split("\n")[0] ?? "").split(" ")[1] ?? ""
  }

  # ... project / workspace / *All verbs unchanged, minus the `version:` argument
}
```

`version` survives as a **read-only report** (the mdx already documents it as
"prints the configured toolchain version"), not as a setting. It's derived from
`toolchain()`, so it stays correct whether `base` is overridden or tracking latest.

`project` / `workspace` pass **`toolchain()`** (the resolved `Container!`) into
`DenoProject` / `DenoWorkspace` where they used to pass `base`. The self call
resolves once, in `Deno`, and the members receive a plain container — they never
self-call, so nothing changes on their side beyond the field they store.

### 4.2 `deno-project.dang` / `deno-workspace.dang`

Delete `let version: String!`, `numGte`, and `supportsPermissionSets`, and drop
`version:` from every constructor call (the `base` field they already take now
carries the resolved `toolchain()` container). `test` and `compile` then always
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

**`dagger/dagger` / `dagger-dang-sdk` — the gate (blocker #2)**

- [ ] Make the `github.com/dagger/dang-sdk` module enable self calls the way the
      built-in `dang` SDK does (advertise `AlwaysEnablesSelfCalls`, or have the
      engine treat the dang runtime as always-self-calls even via the `[…as-sdk]`
      module path). Without this, nothing below is buildable in this repo.

**`dagger/deno`** (unblocked only after the gate above)

- [ ] `deno.dang`: remove `pub version`; make `base` a nullable setting
      (`Container = null`); add `toolchain()` (`base ?? deno.latestImage…`),
      `latestImage` + `latestBinary` (`@cache(ttl: "168h")`, bare pulls);
      `install` uses `deno.latestBinary`; add read-only `version()` off
      `toolchain()`; verbs and members build on `toolchain()`.
- [ ] `deno-project.dang`, `deno-workspace.dang`: drop `version` / `numGte` /
      `supportsPermissionSets`; take the resolved `toolchain()` container in
      place of `base`; `test` and `compile` always use `-P`.
- [ ] `README.md`: drop `settings.version` (L52), the 2.5.0 fallback paragraph
      (L152), `--version 2.9.3` (L216) and `deno(version: "2.9.3")` (L242);
      reframe "reproducible toolchains" (L13) as *latest, refreshed weekly,
      pinnable via `base`*.
- [ ] e2e: cover `latestImage` resolving and `version()` reporting a real
      release; make sure nothing asserts a literal version string.
- [ ] Bump `engineVersion` to whatever release carries #13693.

**`dagger/dagger`**

- [ ] `docs/current_docs/modules/deno.mdx`: remove the `version` bullet, the
      `dagger settings deno version 2.9.3` snippet and the `version = "2.9.3"`
      TOML, and the "`base` and `version` are mutually exclusive" line. Replace
      with: the module tracks the latest Deno release and re-resolves it at most
      weekly; set `base` to pin exactly; permissions still come from `deno.json`,
      which requires Deno >= 2.5.0 if you override `base`. Update the closing
      paragraph so `version` reads as *reports* the toolchain version, not
      *configures* it.

## 7. Verified against `main` @ `d813ed77`

Probed with throwaway modules (built-in `dang` SDK, legacy `dagger.json`,
`experimental.SELF_CALLS: true`):

1. **Self call in a field default → infinite recursion.** `pub base = probe.latestImage…`
   hangs; so does an unrelated `ping()` with that default present, proving the
   default is evaluated eagerly at construction. **Answered:** field-default shape
   is out; §4.1 resolves in `toolchain()` instead.
2. **Self call in a function body → works.** `probe.latestImage.withExec(["deno","--version"])`
   returned `deno 2.9.3` in ~9s. Zero-arg self calls are written **without**
   parens (`probe.latestImage`), matching the upstream example.
3. **Under this repo's SDK (`dang-sdk` module + TOML) → `Error: "probe" not found`.**
   The same function-body self call fails inference — this is blocker #2 in §3.

Still genuinely open:

4. **Is the TTL honoured across calls?** Not yet measured — confirm two calls a
   minute apart reuse one resolved digest, and the cached `Container` carries the
   pinned digest rather than re-resolving `denoland/deno:alpine` downstream.
5. **`denoland/deno:alpine` and `:bin` are the right mutable tags** for "latest
   stable" (vs `:latest`, `:distroless`).
6. **Is 7 days the right TTL,** or is 24h better given the per-engine caveat (§5)?
