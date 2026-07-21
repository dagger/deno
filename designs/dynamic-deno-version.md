# Design: drop the `version` setting, track the latest Deno release

· Status: **proposed** — blocked on [dagger/dagger#13693](https://github.com/dagger/dagger/pull/13693) 
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
call. `container.from("denoland/deno:alpine")` resolves the mutable tag to a
digest once; the engine then serves that same resolved `Container` for the TTL.
Everyone on that engine builds against one digest for a week, then it rolls
forward on its own.

`base` keeps exactly the shape it has today — `.withoutEntrypoint` and the
`DENO_NO_UPDATE_CHECK` env var layered on — and only the `container.from(...)`
underneath is swapped for the self call. The cached function stays a *bare* pull
so its cache key is nothing but "the latest alpine image"; layering our tweaks
inside it would cache them too, and every future tweak would become a
cache-shape change.

`ttl: "168h"` (7 days) is also `MaxFunctionCacheTTLSeconds`
([`core/modfunc.go`](https://github.com/dagger/dagger/blob/main/core/modfunc.go#L26)),
the implicit cap on `Default`-policy results — so we're stating the maximum
explicitly rather than raising it.

### Why it's blocked

Self calls don't resolve today — the module's own name isn't in scope, so
`deno.latestImage` fails inference (confirmed on beta.6 and beta.7).
dagger/dagger#13693 makes those symbols resolvable during the declaration phase
(`ensureModuleSelfTypes`) and gates the declaration-only runner on
`SelfCallsEnabled()`. Nothing here can be built until it lands on `main` and
ships in a release we can target.

## 4. Proposed implementation

### 4.1 `deno.dang`

```dang
type Deno {
  """
  Base container for Deno commands. Defaults to the latest published
  denoland/deno:alpine image, re-resolved at most once a week (see
  `latestImage`). Override to bring your own image or pin an exact release — it
  must have `deno` on PATH, or pass it through `install` first.
  """
  pub base: Container! =
    deno.latestImage
      .withoutEntrypoint
      .withEnvVariable("DENO_NO_UPDATE_CHECK", "1")

  """
  The latest published Deno image, cached for a week. `denoland/deno:alpine` is
  a mutable tag; holding the resolved digest for the TTL means every command in
  the workspace runs against one Deno build for a week before rolling forward.

  Deliberately a bare pull — no entrypoint or env tweaks — so the cache key is
  nothing but "the latest alpine image". `base` layers our defaults on top.
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
    let out = base.withExec(["deno", "--version"]).stdout
    (out.split("\n")[0] ?? "").split(" ")[1] ?? ""
  }

  # ... project / workspace / *All verbs unchanged, minus the `version:` argument
}
```

`version` survives as a **read-only report** (the mdx already documents it as
"prints the configured toolchain version"), not as a setting. It's derived from
whatever `base` is, so it stays correct when `base` is overridden.

### 4.2 `deno-project.dang` / `deno-workspace.dang`

Delete `let version: String!`, `numGte`, and `supportsPermissionSets`, and drop
`version:` from every constructor call. `test` and `compile` then always send
`-P`:

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

**`dagger/deno`**

- [ ] `deno.dang`: remove `pub version`; add `latestImage` + `latestBinary`
      (`@cache(ttl: "168h")`, bare pulls); `base` keeps its current shape on top
      of `deno.latestImage`; `install` uses `deno.latestBinary`; add read-only
      `version()`.
- [ ] `deno-project.dang`, `deno-workspace.dang`: drop `version` / `numGte` /
      `supportsPermissionSets`; `test` and `compile` always use `-P`.
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

## 7. To verify once #13693 lands

1. **Does `base`'s default recurse?** `deno.latestImage` reaches the `deno`
   constructor, which itself has to produce a default for `base`. If defaults are
   evaluated eagerly at construction, that's unbounded; if `base`'s default is
   only evaluated when `base` is read, it's fine. This is the single assumption
   the whole design rests on — test it first.

   If it does recurse, fall back to a nullable setting resolved at the point of
   use, which never constructs `Deno` while constructing `Deno`:

   ```dang
   pub base: Container = null              # unset = track latest
   let toolchain(): Container! {
     base ?? deno.latestImage.withoutEntrypoint.withEnvVariable("DENO_NO_UPDATE_CHECK", "1")
   }
   ```

   Costs some DX (`dagger call deno base` returns null by default, and
   `DenoProject.base` has to become nullable or take the resolved container), so
   it's the fallback, not the plan.
2. **Whether a zero-arg self call takes parens.** Written here as
   `deno.latestImage`, matching the only worked example upstream
   ([`self-calls/main.dang`](https://github.com/dagger/dagger/blob/main/core/integration/testdata/modules/dang/self-calls/main.dang));
   local Dang calls do take them (`supportsPermissionSets()`).
3. **Is the TTL actually honoured for a self call from inside the same module?**
   Confirm two calls a minute apart reuse one resolved digest, and that the
   cached `Container` carries the pinned digest rather than re-resolving the
   mutable tag downstream.
4. **`denoland/deno:alpine` and `:bin` are the right mutable tags** for "latest
   stable" (as opposed to `:latest`, `:distroless`).
5. Whether 7 days is the right TTL, or 24h is a better default given the
   per-engine caveat in §5.
