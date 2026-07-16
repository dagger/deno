# Design: `dagger/deno` — a Dagger module for Deno projects

· Status: **in progress** (v0.1 + v0.2 workspace support shipped — see §0 / §9) 
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

## 0. Implementation status (v0.1, shipped)

`deno.dang` (root `Deno`) + `deno-project.dang` (`DenoProject`); e2e tests in
`.dagger/modules/e2e`. Engine target **v1.0.0-beta.6**. Deltas from the sections
below, learned while building against a real engine:

- **`compile` output arg renamed `output` → `outputName`** — a function arg named
  `output` collides with `dagger call`'s global `-o/--output` flag.
- **`test` permissions come from `deno.json`, not Dagger args** — `test` takes no
  permission arguments; on Deno >= 2.5.0 it runs `deno test -P`, so the project's
  `test.permissions` (or a top-level permission set) governs what tests may do.
  One source of truth, identical locally / in CI / here. Config permission sets +
  `-P` landed in **2.5.0** (2.1.4/2.2/2.3/2.4 reject `-P` outright), so the default
  `version` is pinned to **2.9.3**; if a caller overrides `version` below 2.5.0,
  `test` **falls back to `-A`** (grant all) rather than send the unsupported flag,
  gated by a numeric major.minor compare on `version`. **`compile` mirrors this**:
  it also takes no permission args and bakes the deno.json default set via `-P`
  (`compile` reads the top-level `permissions.default` set, whereas `test` reads
  `test.permissions`). Its pre-2.5.0 fallback differs deliberately — it bakes
  **no** permissions rather than force `-A` into a *shipped* artifact.
- **`audit` not implemented** — deferred (out of scope); wiring `deno audit` is a
  TODO, no longer blocked by the pinned version.
- **`install` needs a glibc base** — the `denoland/deno:bin` binary is
  glibc-linked; for musl/alpine use the default `base`.
- **`Workspace!` is auto-injected** as `currentWorkspace` (no `--ws` arg); the
  `ws`-passing model works transparently on the CLI and in `dagger check`.
- **Discovery is relative to the caller's location** (shykes review): `projects(ws)`
  globs `**/deno.json(c)` from `.` (self + descendants) **and** walks up to the
  workspace root (ancestors as `..`-relative paths), excluding node_modules. See §7.
- **Workspace-wide verbs shipped (v0.2 brought forward)** so the install DX works:
  `lintAll`/`testAll`/`typeCheckAll`/`formatCheckAll` (`@check`) and `formatAll`
  (`@generate`), run on the **caller's cone** (self + descendants, not ancestors).
  After `dagger install github.com/dagger/deno`,
  `dagger check` auto-runs all of them and `dagger generate` runs `formatAll`
  (which also surfaces as a check — a stale-format guard) — verified end-to-end.
  Decision: **aggregate `*All`**, not one auto-check per project (that's what
  Dagger surfaces cleanly today).
- **`test` uses `--permit-no-files`** so a project with no test files is a pass,
  not a `deno test` error (matters for `testAll` across a mixed workspace).
- **Resolved to-verify:** installed multi-file Dang modules with `Workspace` args
  **work** on beta.6 (dagger/dagger#13476 no longer blocks the split); the `base`
  constructor-field default (references `version`, mounts a `cacheVolume`) works
  — though the `DENO_DIR` cache mount now lives in `container(ws)` so a custom
  `base` keeps caching.

## 0.1 Implementation status (v0.2 — Deno workspaces, shipped)

Adds true [Deno workspace](https://docs.deno.com/runtime/fundamentals/workspaces/)
(monorepo) awareness — a root `deno.json` with a `workspace` array of members
sharing one `deno.lock` and import map. New file `deno-workspace.dang`
(`DenoWorkspace`). Deltas learned building against the engine:

- **The correctness fix**: a workspace member's `container(ws)` now mounts the
  **workspace root** (whole tree) and sets the workdir to the member's
  subdirectory, instead of mounting the member subtree alone. `deno` then walks
  up to the shared `deno.lock` / import map and resolves sibling members — so a
  member's `test`/`typeCheck`/`lint` actually pass. The pre-v0.2 per-member mount
  failed on any cross-member import (proven by the `workspace-member-check` e2e).
- **Leverage `deno`'s native fan-out** instead of iterating members: `deno
  lint`/`test`/`check`/`fmt` run at the workspace root already traverse every
  member honoring the exact `workspace` config. So `DenoWorkspace`'s checks are a
  **single exec at the root**, not a per-member `reduce` loop (the `dagger/go`
  `*All` ceremony is unnecessary here — Go has no root fan-out).
- **JSON parsed in-language with `JSON.decode`** — no native Go binary. The design
  anticipated a helper (§6/§7); Dang's type-driven `JSON.decode(text)` decoding into
  a `DenoConfig { workspace: [String!]! }` record reads the `workspace` array
  directly from `File.contents`. (Use the `JSON` namespace — `JSON.decode` /
  `JSON.encode` — never the bare `fromJSON`/`toJSON`.) **Edge**: `JSON.decode` is
  strict JSON, so a `deno.jsonc` root config with comments/trailing commas doesn't
  parse — root detection falls back to a `"workspace"`-key substring check
  (`isWorkspaceRoot`). Root configs are near-always trivial strict JSON, a
  documented corner.
- **Discovery partitions** every `deno.json(c)` into: workspace **roots**
  (`workspaces(ws)`), **members** (reached via a workspace's `members(ws)`), and
  **standalone** projects (`projects(ws)`). `*All` iterates roots (fan-out) +
  standalone, so members are never double-run. `project(ws, path)` resolves a
  member's `workspaceRoot` by walking ancestors, so single-member targeting works.
- **Engine gotcha (e2e only)**: a **cross-module** object list returned by an
  installed dependency (`deno().workspaces(ws)` in the e2e module) is a lazy
  `GraphQL[T!]` that can't be `map`/`filter`/`length`/indexed until materialized,
  and `.{field}` materialization of dependency module-object lists is unreliable
  on beta.6. E2e checks therefore assert workspace behavior through **scalar**
  reads (`.path`, `.workspaceRoot`) + `@check` runs; the exact discovery partition
  (`projects` = 3 standalone, root + 2 members excluded) was verified same-module.

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
 ├─ workspaces(ws)         discover workspace roots (from cwd: self+descendants+ancestors) → [DenoWorkspace]
 ├─ workspace(ws, path)    resolve the workspace containing a path
 ├─ projects(ws)           discover STANDALONE deno.json(c) (from cwd, same reach) → [DenoProject]
 ├─ project(ws, path)      resolve the project containing a path (+ its workspace root)
 ├─ lintAll/testAll/...    check the caller's cone: workspaces (fan-out) + standalone (@check)
 └─ formatAll(ws)          format the caller's cone → one Changeset (@generate)

DenoWorkspace              (a monorepo: root deno.json with a `workspace` array)
 ├─ path                   workspace root, identity
 ├─ config(ws)             the root deno.json(c)
 ├─ members(ws)            the member projects → [DenoProject]
 ├─ source(ws)/container(ws)   the whole workspace, workdir at the root
 ├─ lint/test/typeCheck/formatCheck(ws)  → Void @check  (one exec; deno fans out)
 └─ format(ws)             → Changeset @generate         (deno fmt across all members)

DenoProject                (a project rooted at a workspace-relative path)
 ├─ path                   identity
 ├─ workspaceRoot          the workspace this project belongs to (== path if standalone)
 ├─ config(ws)             the deno.json(c) file
 ├─ source(ws)             the project's source subtree
 ├─ container(ws)          Deno + workspace-root mount + warmed DENO_DIR (workdir = member)
 ├─ lint/test/typeCheck/formatCheck/audit(ws)   → Void @check
 ├─ format(ws)             → Changeset @generate
 └─ compile(ws, ...)       → File   (standalone binary, on demand)
```

Two verbs are intentionally absent (see §3): there is no `@up` (no sensible
default server for an arbitrary project — downstream modules add their own), and
dependency edits are not generators (no value over the CLI).

A `DenoProject` carries **two** identity fields: its own `path` and the
`workspaceRoot` it belongs to. For a standalone project the two are equal and the
container mounts just the project subtree; for a member the container mounts the
workspace root and only moves the workdir, so `deno` resolves the shared lockfile
and sibling members. `DenoWorkspace` is the monorepo peer of `DenoProject`: its
checks run one `deno` command at the root and let the toolchain fan out.

Every node answers a question a user (or agent) might ask. `path` is stored
identity; everything workspace-derived takes `ws` explicitly so cache
invalidation stays visible at the call site.

---

## 5. Configuration & flexibility

The root type carries **only two** constructor inputs — `version` and `base`.
Everything else is derived or scoped to the function that needs it. (In Dang the
public fields of `Deno` *are* the constructor; see §6.)

- **Version**: `version: String! = "2.9.3"` — pins the Deno release used for the
  default base image. Pinned rather than a channel: reproducible, and the Dagger
  lockfile picks up a bump on reload, so no tag drift. Defaults to a release with
  config permission sets (`deno test -P`, added in 2.5.0); older overrides still
  work, with `test` falling back to `-A` below 2.5.0 (see the Permissions bullet).
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
  it is only relevant to the functions that run code — and never global config on
  the root.
  - **`test`**: permissions come entirely from the project's `deno.json`
    (`test.permissions`, or a top-level set). `test` takes **no** permission
    arguments; on Deno >= 2.5.0 it runs `deno test -P`, which activates the config
    set. One source of truth that applies identically at your desk (`deno test
    -P`), in CI, and here — a per-project permission policy that lives with the
    project, not scattered across `dagger call` invocations. Below 2.5.0 (no `-P`)
    it falls back to `-A`, so an older overridden toolchain still runs.
  - **`compile`**: same model, also no permission arguments. `deno compile -P`
    bakes the deno.json **`permissions.default`** set into the binary (a runnable
    app's default runtime permissions — a different config key than `test`'s
    `test.permissions`). Below 2.5.0 it bakes **no** permissions rather than force
    `-A` into a shipped binary (its fallback deliberately differs from `test`'s).
- **No selection config**: bulk verbs run across the caller's cone (self +
  descendants); scoping is done by *where you invoke* `dagger` (the current
  location), or by calling `project(ws, path)` directly. (Gitignore-style selection
  can return later if a real need appears; not worth the constructor surface up front.)

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

  "Deno version for the default base image (>= 2.5.0 uses `test`'s `-P`, else `-A`)."
  version: String!            # default "2.9.3"

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
  Every Deno workspace discovered: each directory whose deno.json declares a
  `workspace` array of members. Discovered relative to the caller's location —
  self + descendants + ancestors (see §7).
  """
  workspaces(ws: Workspace!): [DenoWorkspace!]!

  """
  The Deno workspace containing `path`. With findUp (default) `path` snaps up to
  the nearest ancestor deno.json with a `workspace` array; set findUp: false when
  `path` is already the workspace root.
  """
  workspace(ws: Workspace!, path: String!, findUp: Boolean! = true): DenoWorkspace!

  """
  Every STANDALONE Deno project discovered relative to the caller's location (self
  + descendants + ancestors, paths cwd-relative: `.`, `sub`, `..`): each deno.json(c)
  that is neither a workspace root nor a member of one (those are reached through
  `workspaces` and a workspace's `members`). node_modules is excluded.
  """
  projects(ws: Workspace!): [DenoProject!]!

  """
  The Deno project containing `path`. With findUp (default) `path` may be any
  directory inside a project and snaps to its root; set findUp: false when
  `path` is already a project root (used as given, not normalized). The returned
  project carries its resolved `workspaceRoot`, so a member's commands run against
  the shared workspace.
  """
  project(ws: Workspace!, path: String!, findUp: Boolean! = true): DenoProject!

  # ---- workspace-wide checks ----
  # Each verb runs across the caller's CONE — every workspace (deno fans out over
  # its members) plus every standalone project, self + descendants, never the
  # ancestors `projects`/`workspaces` list. Members are never double-run.

  "Lint every workspace and standalone project in the caller's cone."
  lintAll(ws: Workspace!): Void @check
  "Test every workspace and standalone project in the caller's cone."
  testAll(ws: Workspace!): Void @check
  "Type-check every workspace and standalone project in the caller's cone."
  typeCheckAll(ws: Workspace!): Void @check
  "Check formatting of every workspace and standalone project in the caller's cone."
  formatCheckAll(ws: Workspace!): Void @check

  "Format every workspace and standalone project in the caller's cone; one changeset."
  formatAll(ws: Workspace!): Changeset! @generate
}
```

### 6.2 `type DenoProject` — the project object

```graphql
type DenoProject {
  "Workspace-relative path of this project root."
  path: String!

  """
  Workspace-relative path of the Deno workspace root this project belongs to.
  Equals `path` for a standalone project; for a member it is the directory
  holding the root deno.json whose `workspace` array lists this member.
  """
  workspaceRoot: String!

  # ---- causal introspection ----
  "This project's deno.json / deno.jsonc file."
  config(ws: Workspace!): File!
  "This project's source directory (its subtree of the workspace)."
  source(ws: Workspace!): Directory!
  """
  Container with Deno installed and DENO_DIR warmed. For a standalone project the
  project subtree is mounted at the workdir; for a workspace member the whole
  workspace root is mounted and the workdir is set to the member subdirectory, so
  `deno` resolves the shared deno.lock, import map, and sibling members. The base
  every verb builds on, and the extension point for downstream modules.
  """
  container(ws: Workspace!): Container!

  # ---- checks (dagger check) ----
  "Lint this project (`deno lint`)."
  lint(ws: Workspace!): Void @check
  """
  Run this project's tests. Permissions come from the project's deno.json
  (`test.permissions` / a top-level set) via `deno test -P`, not from arguments;
  below Deno 2.5.0 (no `-P`) it falls back to `-A`.
  """
  test(ws: Workspace!): Void @check
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
  (e.g. "x86_64-unknown-linux-gnu"); null uses the base image's platform. Baked-in
  permissions come from the deno.json `permissions.default` set via `-P` (no
  permission args); below Deno 2.5.0 the binary bakes no permissions.
  """
  compile(
    ws: Workspace!
    entrypoint: String! = "main.ts"
    outputName: String! = "app"   # not `output`: clashes with dagger's -o/--output
    target: String = null
  ): File!

  # No @up: downstream modules add their own `serve(): Service! @up` on top of
  # `container(ws)`. See §8.
}
```

### 6.3 `type DenoWorkspace` — the monorepo object

A workspace root (a deno.json with a `workspace` array). Because `deno` fans a
single command out across all members, every check here is **one exec at the
root** — no per-member iteration.

```graphql
type DenoWorkspace {
  "Workspace-relative path of the workspace root."
  path: String!

  # ---- causal introspection ----
  "The root deno.json / deno.jsonc file."
  config(ws: Workspace!): File!
  "The member projects discovered under this workspace."
  members(ws: Workspace!): [DenoProject!]!
  "The whole workspace subtree."
  source(ws: Workspace!): Directory!
  "Container with the whole workspace mounted, workdir at the root."
  container(ws: Workspace!): Container!

  # ---- checks: one `deno` exec at the root; the toolchain fans out ----
  "Lint every member (`deno lint`)."
  lint(ws: Workspace!): Void @check
  "Test every member (`deno test`)."
  test(ws: Workspace!, permissions: [String!]! = [], allowAll: Boolean! = false): Void @check
  "Type-check every member (`deno check`)."
  typeCheck(ws: Workspace!): Void @check
  "Check formatting of every member (`deno fmt --check`)."
  formatCheck(ws: Workspace!): Void @check

  # ---- generator ----
  "Format the whole workspace (`deno fmt`); one changeset over every member."
  format(ws: Workspace!): Changeset! @generate
}
```

---

## 7. Key implementation notes (Dang sketches)

**Constructor fields — `version` drives a cached default `base`** (both are
public fields, so Dang generates `deno(version:, base:)` with no `new`):

```dang
# deno.dang
type Deno {
  pub version: String! = "2.9.3"
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

**Discovery is relative to the caller's location, not the workspace root.**
`projects` globs `**/deno.json(c)` from `.` (the current workspace location, so
paths come back relative to it) **and** walks up to the workspace root, adding
each ancestor project as a `..`-relative path. Two facts drive this (both verified
against the engine): `ws.directory(path)` resolves *relative* paths from the
current location and *absolute* (`/…`) paths from the root; and `ws.cwd` gives the
current location (`/`, `/sub`, …), whose depth bounds the up-walk. So from `/sub`
with `/deno.json` + `/sub/deno.json`, `projects` returns `.` and `..`; from the
root it returns `.` and `sub`.

The **workspace-wide verbs run on the cone only** — the caller's own project plus
descendants (paths without a `..`), never the ancestors. A `@check` shouldn't
reach up into a parent project you're nested inside, and a `Changeset` rooted at
the caller's location can't represent changes *above* it (a `..` path collapses).
So `projects`/`workspaces` list ancestors for context, but `lintAll` … `formatAll`
filter to `inCone(dir) = !dir.hasPrefix("..")`.

**`container` — mount the *workspace root*, set workdir to the member (v0.2):**

```dang
# deno-project.dang — `workspaceRoot` == `path` for a standalone project
pub container(ws: Workspace!): Container! {
  let rel = if (path == workspaceRoot) { "" } else { path.trimPrefix(workspaceRoot + "/") }
  let workdir = if (rel == "") { "/src" } else { "/src/" + rel }
  base
    .withEnvVariable("DENO_DIR", "/deno-dir")
    .withMountedCache("/deno-dir", cacheVolume("deno-cache"))
    .withDirectory("/src", ws.directory(workspaceRoot, exclude: [".git", "**/node_modules"]))
    .withWorkdir(workdir)
}
```

This is the single most important workspace change (mirrors `dagger/go`): a
member must see the workspace root's `deno.lock` + import map and its sibling
members, so the whole root is mounted and only the workdir moves. Every verb runs
its `deno` command in `workdir` — which scopes to the member while still walking
up to the root. Deps are warmed lazily by `deno` on first exec into `DENO_DIR`
(mounted as a cache volume), so no separate manifest-only install layer is
needed.

**`format` — run `deno fmt`, diff, return a Changeset:**

```dang
pub format(ws: Workspace!): Changeset! @generate {
  let before = source(ws)
  let after = container(ws).withExec(["deno", "fmt"]).directory(".")
  after.changes(before)
}
```

For v0.1 (single project at `.`) the changeset paths are already
workspace-relative. `formatAll` re-roots each project/workspace's changes at its
`path` before merging (the `dagger/go` `generateAll` pattern): build a `before`
directory from each `source(ws)` at its `path`, a matching `after` from each
formatted subtree, then `after.changes(before)` — one workspace-relative
`Changeset`.

**`test` — permissions sourced from `deno.json` via `-P` (no args), with an `-A`
fallback for pre-2.5.0 toolchains:**

```dang
pub test(ws: Workspace!): Void @check {
  # -P applies deno.json's test.permissions (>= 2.5.0); older Deno lacks -P, so
  # fall back to -A. --permit-no-files makes an empty project a pass.
  let permissionFlag = if (supportsPermissionSets()) { "-P" } else { "-A" }
  container(ws).withExec(["deno", "test", "--permit-no-files", permissionFlag]).sync
  null
}

# supportsPermissionSets parses version's major.minor: major > 2, or major == 2
# and minor >= 5. DenoProject carries `version` from the root for this gate.
```

`-P` with no permission config in `deno.json` is safe (grants nothing, no error),
so it is passed unconditionally.

**File layout (multi-file module):** split by type — `deno.dang` (root `Deno`),
`deno-project.dang` (`DenoProject`), `deno-workspace.dang` (`DenoWorkspace`), and
the internal `DenoConfig` record. All `.dang` files in the directory share one
scope, so types cross-reference with no imports.

**Discovering `workspace` roots (v0.2, no native binary):** a root `deno.json`
`workspace` array marks it as a workspace root. Rather than the anticipated native
Go helper, Dang's type-driven `JSON.decode` reads it in-language:

```dang
type DenoConfig { pub workspace: [String!]! = [] }   # partial view of deno.json

let isWorkspaceRoot(ws: Workspace!, dir: String!): Boolean! {
  let text = configText(ws, dir)   # deno.json(c) contents, "" if absent
  try {
    let cfg: DenoConfig! = JSON.decode(text)
    cfg.workspace.length > 0
  } catch {
    err => text.contains("\"workspace\"")   # deno.jsonc-with-comments fallback
  }
}
```

A project's workspace root is the nearest ancestor-or-self that is a workspace
root (`findWorkspaceRoot`, a small recursive walk up `parentDir`). Members
themselves are enumerated by globbing `**/deno.json(c)` under the root — the
workspace-wide checks lean on `deno`'s own resolution, so they honor the exact
`workspace` array (globs/excludes) regardless of how `members` globs. Deno needs
far less native help than Go — no import graph, no helper binary.

---

## 8. Extendability

Downstream authors `dagger install github.com/dagger/deno`, then call `deno(...)`:

```dang
type MyApp {
  "Full CI for this app: reuse the deno module's checks, add our own."
  pub ci(ws: Workspace!): Void @check {
    let project = deno(version: "2.9.3").project(ws, ".")
    project.lint(ws)
    project.typeCheck(ws)
    project.test(ws)   # permissions come from deno.json's test.permissions
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

**v0.1 — shipped**

- [x] root `Deno`: `version`, `base`, `install(ctr)`
- [x] single-project lookup: `project(ws, path, findUp)` (find-up to nearest deno.json/deno.jsonc)
- [x] checks: `lint` / `test` (`deno test -P`, permissions from deno.json) / `typeCheck` / `formatCheck`
- [x] `format` generator (`@generate` → changeset)
- [x] `compile` (→ `File!`)
- [x] introspection: `config` / `source` / `container`
- [x] multi-file layout (`deno.dang`, `deno-project.dang`)
- [x] e2e tests (`.dagger/modules/e2e`) + `README.md`
- [x] discovery relative to the caller's location: `projects(ws)` = self + descendants
      (glob from `.`) + ancestors (walk up to the workspace root), cwd-relative paths
- [x] `*All` bulk verbs: `lintAll`/`testAll`/`typeCheckAll`/`formatCheckAll` + `formatAll`
      generator, scoped to the caller's cone (ancestors excluded)
- [x] install DX: `dagger check` / `dagger generate` auto-run the `*All` verbs
- [x] decision: aggregate `*All` (not one auto-check per project)
- [x] `test` permissions sourced from `deno.json` via `deno test -P` (no Dagger
      args); default `version` bumped to `2.9.3`, with an `-A` fallback below 2.5.0
- [ ] ~~`audit`~~ — deferred (out of scope); no longer version-blocked

**v0.2 — shipped (Deno workspaces)**

- [x] `deno.json` `workspace`-array awareness — `JSON.decode` in-language (no native
      binary); each root/member/standalone discovered and partitioned
- [x] `DenoWorkspace` type (`deno-workspace.dang`): `members`, `container`, and
      root-level `lint`/`test`/`typeCheck`/`formatCheck` (@check) + `format`
      (@generate) that let `deno` fan out over members
- [x] discovery: `workspaces(ws)` + `workspace(ws, path, findUp)`; `projects(ws)`
      now standalone-only; `project(ws, path)` resolves `workspaceRoot`
- [x] **member container fix**: mount the workspace root, workdir = member (shared
      lockfile / import map / cross-member imports resolve)
- [x] `*All` iterates workspaces (fan-out) + standalone projects (no double-run)
- [x] e2e: real workspace fixture (root + 2 members, cross-member import) +
      `workspace-check` / `workspace-member-check`

**later**

- [ ] honor `workspace`-array globs/excludes in `members(ws)` (today it globs
      subdir configs; the *checks* already honor them via `deno`'s own resolution)
- [ ] robust `deno.jsonc` (comment/trailing-comma) root parsing beyond the
      substring fallback (normalize through the Deno toolchain if a real need appears)
- [ ] `coverage` / `bench` once Dagger has the DX to surface reports
- [ ] `audit` — wire `deno audit` (now available in the pinned version)
- [ ] `publish` (JSR, secret auth); Deno Deploy

## 10. Decisions & things to verify

**Resolved in review:**

- **Pin `version`** to an exact release; rely on the Dagger lockfile to pick up a
  tag change on reload (no channel).
- **`ws`-passing model** (no stored `source`), workspace-first for monorepos.
- **`test` and `compile` permissions live in `deno.json`** (`-P`), never in Dagger
  args — one policy shared across desk/CI/module. `test` reads `test.permissions`,
  `compile` bakes the top-level `permissions.default` set. Never root config
  either way. (Superseded the earlier "`permissions` scoped to `test`/`compile`"
  arg-based decision — both are now config-driven; the default `version` is `2.9.3`
  for `-P`, with `test` falling back to `-A` and `compile` to no permissions on
  overrides below 2.5.0.)
- **No dependency-edit functions** (`add`/`remove`/`outdated`): they'd just wrap
  the CLI with no added value.
- **Multi-file module** (`deno.dang`, `deno-project.dang`, …).
- **Cut as redundant**: `baseImageAddress`, root-level `permissions`/`allowAll`,
  selection-pattern config, and the public `withCache` knob.

**To verify (before/while building):**

- ~~**Per-project checks**~~ — **decided**: ship aggregate `*All` verbs
  (`lintAll`/`testAll`/…). They surface cleanly as one `dagger check` entry each
  and auto-run after install. Whether a single `@check` can fan out into one
  entry *per* discovered project is still an open Dagger-API question, but the
  aggregate is the right v0.2 shape and works today.
- ~~**Installed multi-file Dang modules with `Workspace` args**~~ — **resolved**:
  works on v1.0.0-beta.6. The e2e module installs the multi-file `deno` module and
  drives its `Workspace`-taking functions; dagger/dagger#13476 no longer blocks
  the split.
- ~~**`base` field default**~~ — **resolved**: a constructor-field default that
  references `version` and mounts a `cacheVolume` works. (The `DENO_DIR` cache
  mount was moved into `container(ws)` so a custom `base` still gets caching.)
- **Source over-mounting**: `source = ws.directory(path)` includes the whole
  subtree (good for runtime-read assets/testdata) — confirm we don't need
  targeted excludes for large data dirs. For a workspace member, `container(ws)`
  now mounts the *entire workspace root* (necessary for shared config/lock) — a
  larger cache key than a standalone project, but correctness requires it.
- ~~**Reading `deno.json`'s `workspace` array**~~ — **resolved**: `JSON.decode` +
  `File.contents` in pure Dang (verified on beta.6); no native binary. `JSON.decode`
  is strict JSON, so `deno.jsonc` roots with comments fall back to a `"workspace"`
  substring check. (Use the `JSON` namespace, never bare `fromJSON`/`toJSON`.)
- **Cross-module module-object lists (engine limitation, beta.6)**: a list of a
  *dependency's* object type (`deno().workspaces(ws)`/`members(ws)` called from
  the e2e module) is a lazy `GraphQL[T!]` — `map`/`filter`/`length`/indexing all
  error until materialized, and `.{field}` materialization of dependency
  module-object lists is unreliable. Same-module list ops (inside `deno.dang`)
  work fine. E2e asserts workspace behavior via scalars (`.path`,
  `.workspaceRoot`) + `@check` runs instead; revisit if a later engine lifts this.
</content>
