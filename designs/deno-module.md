# Design: `dagger/deno` — a Dagger module for Deno projects

· Status: **draft / for review** 
· SDK: **Dang** 
· Module name: **`deno`** 
· Root type: **`Deno`**

A Dagger module for managing [Deno](https://deno.com) projects. It does **not**
just shell out to the `deno` CLI — it models a Deno project as a domain object
graph and maps Deno's toolchain onto Dagger's first-class verbs (`dagger check`,
`dagger generate`, `dagger up`), with reproducible toolchains, cached
dependencies, reviewable diffs, and monorepo/workspace awareness.

Follows the rubric in [`hacks/ideal-dagger-primitive-module.md`](../hacks/ideal-dagger-primitive-module.md).
Modeled on [`dagger/go`](https://github.com/dagger/go) (advanced, workspace-aware)
and [`dagger/node`](https://github.com/dagger/node) (simple, composable).

---

## 1. Goals & non-goals

**Goals**

- A convenient, reproducible way to manage a Deno project or a Deno
  [workspace](https://docs.deno.com/runtime/fundamentals/workspaces/) (monorepo),
  not a 1:1 CLI proxy.
- Deno's toolchain surfaced as Dagger verbs: `lint`/`test`/`check`/`fmt --check`/
  `audit` → `@check`; `fmt` → `@generate` (a no-arg, idempotent normalization).
- Configurable and flexible: pinned Deno version, BYO base image, an
  `install(ctr)` primitive that installs the Deno CLI into *any* container.
- Extendable: a good starting point that downstream modules install as a
  dependency and build on.

**Non-goals (v1)**

- Publishing to JSR (`deno publish`) — needs OIDC/token secrets; add later.
- Deno Deploy integration.
- `deno jupyter`, `deno repl`, `deno desktop`.

---

## 2. Why use this over the `deno` CLI

| Concern | Raw `deno` CLI | `dagger/deno` |
|---|---|---|
| **Reproducibility** | whatever Deno is on `PATH` | pinned `version` + pinned base image, same everywhere |
| **Dependency cache** | local `DENO_DIR`, cold in CI | `DENO_DIR` mounted as a Dagger `cacheVolume`, warm & shared across every check |
| **Formatting** | `deno fmt` mutates files in place | returned as a `Changeset` — **diff previewed and confirmed** before anything is written (great for agents & PR bots) |
| **Dev server** | `deno serve` ties up a terminal | a one-line `@up` on top of `container(ws)` in your module → `dagger up` port-forwards to the host (the base module leaves the entrypoint to you) |
| **Monorepos** | run per-member by hand | discover `deno.json` members, run a verb across all of them |
| **Composability** | bash glue | typed objects that compose into images, pipelines, other modules |
| **Extensibility** | copy-paste scripts | install as a dependency; wrap `DenoProject` in your own module |

---

## 3. Deno → Dagger mapping

| Deno command | Purpose | Module function | Dagger verb |
|---|---|---|---|
| `deno lint` | lint | `DenoProject.lint` | `@check` |
| `deno test` | test | `DenoProject.test` | `@check` |
| `deno check` | typecheck | `DenoProject.typeCheck` | `@check` |
| `deno fmt --check` | format check | `DenoProject.formatCheck` | `@check` |
| `deno audit` | vuln audit | `DenoProject.audit` | `@check` |
| `deno fmt` | format (write) | `DenoProject.format` | `@generate` |
| `deno install` (deps) | warm cache | folded into `DenoProject.container` (build layer) | — |
| `deno compile` | standalone binary | `DenoProject.compile` | (returns `File!`) |
| `deno coverage` | coverage report | _deferred (needs Dagger DX)_ | — |
| `deno bench` | benchmarks | _deferred (needs Dagger DX)_ | — |

Config file: `deno.json` / `deno.jsonc`. Lockfile: `deno.lock`. Dependency
cache dir: **`DENO_DIR`**. `deno.json` supports `tasks`, `workspace` (monorepo
members), `imports` (import map), `fmt`, `lint`, `test`, `nodeModulesDir`.

### Deliberately excluded (and why)

`@generate` and `@up` functions are **auto-run with their defaults** — `dagger
generate` runs every `@generate` in the workspace, `dagger up` starts every
`@up`. So a function only belongs on those verbs if running it with no arguments,
automatically, alongside every sibling, makes sense. That rules several Deno
commands out:

- **`deno add` / `deno remove` / `deno outdated --update`** — parameterized by
  *which package* (or a non-idempotent version bump); no sensible default, and
  you don't want a dependency edit firing on every `dagger generate`. Beyond not
  fitting `@generate`, exposing them at all would just be the `deno` CLI wrapped
  in Dagger with **no added value** — so we don't. Manage dependencies with the
  `deno` CLI locally (module-level deps live in the dang-sdk management module).
- **`deno serve` / `deno run`** — a server's entrypoint, port, and permissions
  can't be guessed for an arbitrary project, so it is a poor `@up` (it would
  auto-start on every `dagger up` with a made-up `main.ts`). We omit `@up`
  entirely; a **downstream module that knows its own entrypoint** adds a one-line
  `@up serve` on top of `container(ws)` (see §8).
- **`deno task <name>`** — user tasks are arbitrary shell we can't model or
  predict, and a user who wrote a task already has whatever it needs installed.
  Wrapping "run any task" adds nothing over `deno task` locally.
- **`deno doc` / `deno info`** — low value inside a pipeline; dropped.
- **`deno coverage` / `deno bench`** — kept in the table but **deferred**: making
  their reports first-class needs Dagger DX we don't have yet.

### `compile` is a build artifact, not a generator

`compile` returns a `File!` (the standalone binary) — deliberately **not** a
`@check` and **not** a `@generate`:

- Not a check, so a lint/format error never blocks a build.
- Not a generator: a compiled binary is a *shipped artifact*, not checked-in
  generated source. You export it (`dagger call deno … compile export --path
  ./app`) or feed it into an image (§8), rather than writing a binary back into
  your repo. Making it `@generate` would both commit a binary into the tree and
  rebuild it on every `dagger generate` (the auto-run test). It stays a plain
  output the caller pulls on demand.

---

## 4. Domain object graph

```
Deno                       (toolchain config: version, base)
 ├─ version, base          constructor inputs (base derived from version)
 ├─ install(ctr)           install the Deno CLI + cache into any container
 ├─ projects(ws)           discover every deno.json(c) → [DenoProject]
 ├─ project(ws, path)      resolve the project containing a path
 ├─ lintAll/testAll/...    check every discovered project (@check)
 └─ formatAll(ws)          format every project → one Changeset (@generate)

DenoProject                (a project rooted at a workspace-relative path)
 ├─ path                   identity
 ├─ config(ws)             the deno.json(c) file
 ├─ source(ws)             the project's source subtree
 ├─ container(ws)          Deno + source + warmed DENO_DIR + deps installed
 ├─ lint/test/typeCheck/formatCheck/audit(ws)   → Void @check
 ├─ format(ws)             → Changeset @generate
 └─ compile(ws, ...)       → File   (standalone binary, on demand)
```

Two verbs are intentionally absent (see §3): there is no `@up` (no sensible
default server for an arbitrary project — downstream modules add their own), and
dependency edits are not generators (no value over the CLI).

Every node answers a question a user (or agent) might ask. `path` is stored
identity; everything workspace-derived takes `ws` explicitly so cache
invalidation stays visible at the call site.

---

## 5. Configuration & flexibility

The root type carries **only two** constructor inputs — `version` and `base`.
Everything else is derived or scoped to the function that needs it. (In Dang the
public fields of `Deno` *are* the constructor; see §6.)

- **Version**: `version: String! = "2.1.4"` — pins the Deno release used for the
  default base image. Pinned rather than a channel: reproducible, and the Dagger
  lockfile picks up a bump on reload, so no tag drift.
- **Base**: `base: Container!` defaults to `denoland/deno:alpine-<version>` with
  `DENO_DIR` configured. Override it to bring your own image (distroless, an app
  image, a specific `alpine`/`debian`/`distroless` variant); it just needs `deno`
  on PATH, or run it through `install` first. This is the single, unambiguous
  configuration point — there is no separate `baseImageAddress`.
- **`install(ctr)`**: copies `/deno` from `denoland/deno:bin-<version>` into any
  container via `withFile` and wires the `DENO_DIR` cache. Hermetic (no install
  script), so callers can add Deno to a base that doesn't have it.
- **Caching**: `DENO_DIR` set to `/deno-dir` and mounted as
  `cacheVolume("deno-cache")`; deps are warmed by running `deno install` after
  mounting `deno.json` + `deno.lock` **before** full source, so the dependency
  layer caches independently of source edits. This is internal to `base` /
  `install` / `container` — there is no public `withCache` knob.
- **Permissions**: Deno's explicit-permission model is a real differentiator, but
  it is only relevant to the functions that run code. `test` and `compile` take
  their own `permissions: [String!]!` (e.g. `["--allow-net", "--allow-read"]`)
  plus an `allowAll: Boolean! = false` convenience for `-A` — **not** global
  config on the root.
- **No selection config**: bulk verbs run across every discovered project.
  Consumers scope by calling `project(ws, path)` directly or filtering the
  `projects(ws)` list. (Gitignore-style selection can return later if a real need
  appears; it isn't worth the constructor surface up front.)

---

## 6. Public API — GraphQL

> The module's public surface *is* a GraphQL schema. In Dang there is no separate
> constructor function: the **public fields of the root `Deno` type are the
> constructor arguments** (the `dagger/node` style), so the engine generates
> `deno(version: String, base: Container): Deno!` on `Query` from the two input
> fields below — no hand-written `new` needed. `@check` / `@generate` mark the
> first-class verbs; `@defaultPath` / `@ignorePatterns` are Dagger workspace
> directives.

### 6.1 `type Deno` — toolchain config, primitives, discovery

```graphql
"""
A Dagger module for Deno — a modern runtime for JavaScript and TypeScript.
https://deno.com
"""
type Deno {
  # ---- constructor inputs (become the generated `deno(...)` args) ----

  "Deno version used for the default base image."
  version: String!            # default "2.1.4"

  """
  Base container for Deno commands. Defaults to denoland/deno:<version> with the
  DENO_DIR cache configured. Override to bring your own image (distroless, an app
  image, a specific variant) — it must have `deno` on PATH, or pass it through
  `install` first.
  """
  base: Container!

  # ---- composable container primitive ----

  """
  Install the Deno CLI and DENO_DIR cache into any container and return it.
  Copies the `deno` binary from denoland/deno:bin-<version>; use it to add Deno
  to a base that doesn't already have it.
  """
  install(ctr: Container!): Container!

  # ---- discovery & lookup ----

  """
  Every Deno project discovered in the workspace: each deno.json(c), plus each
  member listed in a root deno.json `workspace` array.
  """
  projects(ws: Workspace!): [DenoProject!]!

  """
  The Deno project containing `path`. With findUp (default) `path` may be any
  directory inside a project and snaps to its root; set findUp: false when
  `path` is already a project root.
  """
  project(ws: Workspace!, path: String!, findUp: Boolean! = true): DenoProject!

  # ---- workspace-wide checks ----
  # One aggregate check per verb today; see §10 "To verify" on whether the API
  # can instead surface one check *per project* automatically.

  "Lint every discovered project."
  lintAll(ws: Workspace!): Void @check
  "Test every discovered project."
  testAll(ws: Workspace!): Void @check
  "Type-check every discovered project."
  typeCheckAll(ws: Workspace!): Void @check
  "Check formatting of every discovered project."
  formatCheckAll(ws: Workspace!): Void @check

  "Format every discovered project; returns one reviewable changeset."
  formatAll(ws: Workspace!): Changeset! @generate
}
```

### 6.2 `type DenoProject` — the project object

```graphql
type DenoProject {
  "Workspace-relative path of this project root."
  path: String!

  # ---- causal introspection ----
  "This project's deno.json / deno.jsonc file."
  config(ws: Workspace!): File!
  "This project's source directory (its subtree of the workspace)."
  source(ws: Workspace!): Directory!
  """
  Container with Deno installed, DENO_DIR warmed, deps installed (`deno install`)
  and this project's source mounted at the workdir. The base every verb builds
  on, and the extension point for downstream modules.
  """
  container(ws: Workspace!): Container!

  # ---- checks (dagger check) ----
  "Lint this project (`deno lint`)."
  lint(ws: Workspace!): Void @check
  """
  Run this project's tests (`deno test`). `permissions`/`allowAll` control the
  granted Deno permissions.
  """
  test(ws: Workspace!, permissions: [String!]! = [], allowAll: Boolean! = false): Void @check
  "Type-check without running (`deno check`)."
  typeCheck(ws: Workspace!): Void @check
  "Check formatting without writing (`deno fmt --check`)."
  formatCheck(ws: Workspace!): Void @check
  "Audit dependencies for known vulnerabilities (`deno audit`)."
  audit(ws: Workspace!): Void @check

  # ---- generator (dagger generate) ----
  # Only `format` qualifies: a no-arg, idempotent, whole-project normalization.
  "Format the project (`deno fmt`); returns the diff for review before writing."
  format(ws: Workspace!): Changeset! @generate

  # ---- build artifact (plain output, not a verb — see §3) ----
  """
  Compile a standalone executable (`deno compile`). `target` cross-compiles
  (e.g. "x86_64-unknown-linux-gnu"); null uses the base image's platform.
  `permissions`/`allowAll` bake default permissions into the binary.
  """
  compile(
    ws: Workspace!
    entrypoint: String! = "main.ts"
    output: String! = "app"
    target: String = null
    permissions: [String!]! = []
    allowAll: Boolean! = false
  ): File!

  # No @up: downstream modules add their own `serve(): Service! @up` on top of
  # `container(ws)`. See §8.
}
```

---

## 7. Key implementation notes (Dang sketches)

**Constructor fields — `version` drives a cached default `base`** (both are
public fields, so Dang generates `deno(version:, base:)` with no `new`):

```dang
# deno.dang
type Deno {
  pub version: String! = "2.1.4"
  pub base: Container! =
    container.from("denoland/deno:alpine-" + version)
      .withEnvVariable("DENO_DIR", "/deno-dir")
      .withMountedCache("/deno-dir", cacheVolume("deno-cache"))
      .withEnvVariable("DENO_NO_UPDATE_CHECK", "1")
}
```

**`install` — copy the binary into a BYO base and wire the cache:**

```dang
pub install(ctr: Container!): Container! {
  let denoBin = container.from("denoland/deno:bin-" + version).file("/deno")
  ctr
    .withFile("/usr/local/bin/deno", denoBin, permissions: 0755)
    .withEnvVariable("DENO_DIR", "/deno-dir")
    .withMountedCache("/deno-dir", cacheVolume("deno-cache"))
}
```

**`source` — just the project subtree (no import-graph walk needed):**

```dang
# deno-project.dang
pub source(ws: Workspace!): Directory! {
  ws.directory(path, exclude: [".git", "**/node_modules"])
}
```

Unlike Go, a Deno project's source *is* its directory: there's no in-tree
`node_modules` and the dependency cache lives outside the tree in `DENO_DIR`, so
no include-graph discovery is required.

**`container` — cache deps independently of source (manifests first):**

```dang
pub container(ws: Workspace!): Container! {
  # dependency layer: mount only the manifests, warm DENO_DIR — caches on their
  # content, independent of source edits
  let deps = base
    .withWorkdir("/src")
    .withDirectory("/src", ws.directory(path, include: ["deno.json", "deno.jsonc", "deno.lock"]))
    .withExec(["deno", "install"])
  # source on top
  deps.withDirectory("/src", source(ws))
}
```

**`format` — run `deno fmt`, diff, return a Changeset:**

```dang
pub format(ws: Workspace!): Changeset! @generate {
  let before = source(ws)
  let after = container(ws).withExec(["deno", "fmt"]).directory(".")
  after.changes(before)
}
```

For v0.1 (single project at `.`) the changeset paths are already
workspace-relative. Multi-project generate must re-root each project's changes
at its `path` before merging (the `dagger/go` `generateAll` pattern) — a phase-2
concern.

**`test` — permissions assembled from args:**

```dang
pub test(ws: Workspace!, permissions: [String!]! = [], allowAll: Boolean! = false): Void @check {
  let perms = if (allowAll) { ["-A"] } else { permissions }
  container(ws).withExec(["deno", "test"] + perms).sync
  null
}
```

**File layout (multi-file module):** split by type — `deno.dang` (root `Deno`),
`deno-project.dang` (`DenoProject`), and future types each in their own file. All
`.dang` files in the directory share one scope, so types cross-reference with no
imports. (See §10 "To verify" on installed multi-file modules with `Workspace`
args.)

**Discovering `workspace` members (phase 2):** a root `deno.json` `workspace`
array lists member paths. Read it by globbing `**/deno.json` (each is a project),
or, if we need the array itself, with a tiny native helper that parses the JSON
(the `dagger/go` helper pattern). Deno needs far less native help than Go — no
import graph to resolve.

---

## 8. Extendability

Downstream authors `dagger install github.com/dagger/deno`, then call `deno(...)`:

```dang
type MyApp {
  "Full CI for this app: reuse the deno module's checks, add our own."
  pub ci(ws: Workspace!): Void @check {
    let project = deno(version: "2.1.4").project(ws, ".")
    project.lint(ws)
    project.typeCheck(ws)
    project.test(ws, allowAll: true)
    smokeTest(ws)   # our own extra check
  }

  "Ship a minimal image using the compiled binary + distroless base."
  pub image(ws: Workspace!): Container! {
    let bin = deno().project(ws, ".").compile(ws, output: "server")
    container.from("gcr.io/distroless/cc").withFile("/server", bin).withEntrypoint(["/server"])
  }

  # The module deliberately ships no @up. A consumer that knows its own
  # entrypoint/port adds one in a single line on top of `container(ws)`.
  "Run *this* app's dev server (`dagger up`)."
  pub serve(ws: Workspace!): Service! @up {
    deno().project(ws, ".").container(ws)
      .withExposedPort(8000)
      .asService(args: ["deno", "serve", "--allow-net", "--port", "8000", "src/main.ts"])
  }
}
```

Because the module exposes composable primitives (`install`, `base`), a rich
child object (`DenoProject`), and causal introspection (`config`, `source`,
`container`), consumers extend by composition without forking — including
supplying the `@up` service the base module intentionally leaves to them.

---

## 9. Phasing

1. **v0.1** — root `Deno` (`version`, `base`, `install`), single-project via
   `project(ws, ".")`, checks (`lint`/`test`/`typeCheck`/`formatCheck`/`audit`),
   `format` generator, `compile`. Multi-file layout (`deno.dang`,
   `deno-project.dang`) from the start. Ship the composable primitives first.
2. **v0.2** — multi-project discovery (`projects`, `deno.json` `workspace`
   members), `*All` bulk verbs, native helper for `workspace` parsing.
3. **later** — `coverage`/`bench` once Dagger has the DX to surface reports;
   `publish` (JSR, secret auth); Deno Deploy.

## 10. Decisions & things to verify

**Resolved in review:**

- **Pin `version`** to an exact release; rely on the Dagger lockfile to pick up a
  tag change on reload (no channel).
- **`ws`-passing model** (no stored `source`), workspace-first for monorepos.
- **Permissions** are a `[String!]!` + `allowAll`, **scoped to `test`/`compile`**,
  not root config.
- **No dependency-edit functions** (`add`/`remove`/`outdated`): they'd just wrap
  the CLI with no added value.
- **Multi-file module** (`deno.dang`, `deno-project.dang`, …).
- **Cut as redundant**: `baseImageAddress`, root-level `permissions`/`allowAll`,
  selection-pattern config, and the public `withCache` knob.

**To verify (before/while building):**

- **Per-project checks**: can the Dagger API surface **one check per discovered
  project automatically** (each project as its own `dagger check` entry), instead
  of a single aggregate `lintAll`/`testAll`? Investigate `Workspace.checks` /
  check-group registration and whether a `@check` can fan out dynamically. If it
  can, prefer per-project checks over the `*All` aggregates.
- **Installed multi-file Dang modules with `Workspace` args**: `dagger/go`
  deliberately kept one `.dang` file pending Dagger v0.21 (dagger/dagger#13476 —
  `Workspace` arg conversion for installed multi-file Dang toolchains). Confirm
  this works on our target engine before relying on the multi-file split for an
  *installed* module.
- **`base` field default**: confirm a stored constructor-field default may build
  a `Container!` that references another field (`version`) and mounts a
  `cacheVolume` (expected per Dang `objects.md`, but verify on the engine). If
  not, move the wiring into an explicit `new`.
- **Source over-mounting**: `source = ws.directory(path)` includes the whole
  subtree (good for runtime-read assets/testdata) — confirm we don't need
  targeted excludes for large data dirs.
</content>
