# Deno module for Dagger

A [Dagger](https://dagger.io) module for [Deno](https://deno.com) projects,
written in [Dang](https://docs.dagger.io/next/extending/sdks/dang/).

It does **not** just wrap the `deno` CLI. It models a Deno project as a typed
object graph and maps Deno's toolchain onto Dagger's first-class verbs, so you
get:

- **CI by design** — the very same checks run at your desk and in CI, in one
  pinned, consistent environment. `dagger check` locally is byte-for-byte what CI
  runs, so there is no separate pipeline to maintain and no "works on my machine".
- **Reproducible toolchains** — a pinned Deno version and base image, the same
  everywhere.
- **Warm dependency cache** — `DENO_DIR` mounted as a Dagger cache volume, shared
  across every run.
- **Reviewable formatting that can't go stale** — `deno fmt` comes back as a
  *changeset* you preview and confirm before anything is written (great for agents
  and PR bots). And because Dagger surfaces every `@generate` as a check as well,
  a formatting generator doubles as an "is formatting up to date?" check — CI
  fails when the output drifts, with no extra wiring.
- **Monorepo-aware** — a Deno [workspace](https://docs.deno.com/runtime/fundamentals/workspaces/)
  (a root `deno.json` with a `workspace` array) is a first-class object: checks
  fan out across every member, and a single member's checks still resolve the
  shared lockfile, import map, and sibling packages.
- **Selectable** — projects and workspaces are Dagger collections, so you can
  list them and run checks on just the ones you name
  (`--deno-project=apps/api`).
- **Composability** — install Deno into any container, produce standalone
  binaries, and extend it from your own module.

See [`designs/deno-module.md`](./designs/deno-module.md) for the full design.

## Requirements

Requires Dagger **v1.0.0-beta.15** or later.

## Quick start

The examples below use this layout: two standalone projects and a Deno
workspace with two members.

```
apps/api/deno.json          standalone project
apps/web/deno.json          standalone project
packages/deno.json          Deno workspace: { "workspace": ["./core", "./ui"] }
packages/core/deno.json     member
packages/ui/deno.json       member
```

**1. Install the module** into your workspace:

```sh
dagger install github.com/dagger/deno
```

This adds a `[modules.deno]` entry to your `dagger.toml`. Its settings:

| Setting | Default | Meaning |
|---|---|---|
| `version` | `"2.9.3"` | Deno version for the default base image (`denoland/deno:alpine-<version>`). |
| `base` | the image above | Base container for Deno commands; it must have `deno` on `PATH`. |
| `permissions` | `"config"` | Permissions for `test` and `compile`: `"config"` (the deno.json permission sets, `-P`), `"all"` (`-A`) or `"none"`. See [Test permissions](#test-permissions). |
| `testArgs` | `[]` | Extra `deno test` flags, e.g. `["--doc", "--parallel", "--ignore=_tools/"]`. |
| `typeCheckArgs` | `[]` | Extra `deno check` flags, e.g. `["--allow-import"]`. |
| `typeCheckTargets` | `["."]` | What `type-check` checks, relative to *each* project or workspace root, e.g. `["mod.ts"]`. See [Type-check](#type-check). |

`dagger settings deno` lists them (its VALUE column shows only what you've
set). Set one with `dagger settings deno <key> <value>`; list values are JSON:

```sh
dagger settings deno version 2.9.3
dagger settings deno permissions all
dagger settings deno testArgs '["--doc"]'
dagger settings -u deno testArgs           # unset: back to the default
```

The first three write

```toml
[modules.deno.settings]
version = "2.9.3"
permissions = "all"
testArgs = ["--doc"]
```

The same settings apply to every project and workspace the module checks.

**2. Run checks and generators.** Projects and workspaces are discovered from
where you stand (see [Discovery](#discovery)):

```sh
dagger check      # lint, test, type-check and format-check every project and workspace
dagger generate -y   # format: runs `deno fmt` and writes the result
```

These are Dagger's first-class verbs, so the same commands run identically in CI
— there is no separate pipeline to maintain. And because Dagger surfaces every
generator as a check too, `dagger check` *also* fails when your formatting is out
of date (the `stale` check).

**3. Select what runs** by project, workspace, or check name:

```sh
dagger list deno-projects -a                        # standalone projects, by path
dagger list deno-workspaces -a                      # Deno workspaces, by root path
dagger check -l --all                               # one line per project/workspace and check

dagger check --deno-project=apps/api                # every check on one project
dagger check --deno --check test --deno-project=apps/api --deno-project=apps/web
dagger check deno/projects/lint                     # one check on every project
dagger check deno/workspaces/test --deno-workspace=packages
dagger generate -y --deno-project=apps/api          # format just that project
dagger -W ./apps/api check                          # or scope by directory
```

Or just `cd` into the project: from inside it, it is the only one selected, with
no flag needed:

```sh
cd apps/api/src && dagger check        # checks apps/api
```

**4. Or call functions directly.** `dagger call` reaches the rest of the API:
looking a project up by path, its workspace root, `compile`, `container`.
`--path` may point *inside* a project; it snaps up to the nearest `deno.json` /
`deno.jsonc` (pass `--find-up=false` when it is already a root):

```sh
dagger call deno project --path apps/api/src path    # -> apps/api
dagger call deno project --path apps/api test
```

> **Use `dagger check` in CI.** `dagger call` on a check function (`lint`,
> `test`, `type-check`, `format-check`) prints the result, but the command
> exits 0 even when the check fails. `dagger check` fails the command.

> Don't want to install? Run a function one-off with `-m`, dropping the module
> name: `dagger -m github.com/dagger/deno call project --path apps/api path`.

## Discovery

`dagger check`, `dagger generate` and `dagger list` find Deno configs with
`Workspace.findRoots`, starting from the directory you run them in:

- every directory with a `deno.json` / `deno.jsonc` at or below it, and
- when that directory is not itself a project root, the nearest project
  enclosing it.

So:

| You run from | Selected |
|---|---|
| a project root (`apps/api`) | that project, and any project below it |
| inside a project (`apps/api/src`) | that project (the enclosing one), and any project below |
| a directory in no project (the repo root, `apps`) | every project below it |

A project above a project root you stand in is not selected; `project` /
`workspace` still reach it by path.

Each config directory then lands in exactly one collection:

- A directory whose config declares a non-empty `workspace` array is a **Deno
  workspace** (`workspaces`, keyed by its root).
- A directory below a discovered workspace root is one of its members and is
  checked through the workspace, not on its own.
- Every other directory is a **standalone project** (`projects`, keyed by its
  root).

Inside a workspace **member** (`packages/ui/src`), the member is the nearest
enclosing project, so the member is selected — not the whole workspace. Its
commands run from the workspace root with the member as the target
(`deno test ui`), as a workspace's own CI does, so the shared `deno.lock`,
import map and sibling packages resolve and tests see the root as their cwd;
`dagger check` there checks just that member.
Inside a workspace directory that belongs to no member (`packages/docs`), the
workspace itself is selected.

Keys are workspace-root-relative paths. Listing runs no container and no `deno`:
one `findRoots` walk, one ripgrep search for configs mentioning `"workspace"`
(only those few are read and parsed), and a `findUp` hop per enclosing project
to find the workspace a project belongs to. `node_modules` is skipped.
Discovery is static, so it doesn't evaluate `deno.json` beyond the `workspace`
array: a member listed in a workspace but missing its own config is covered by
the workspace but never selected on its own, and a directory below a workspace
root counts as a member even if the `workspace` array doesn't list it.

## Monorepos (Deno workspaces)

A [Deno workspace](https://docs.deno.com/runtime/fundamentals/workspaces/) — a
root `deno.json` with a `workspace` array of member packages sharing one
`deno.lock` and import map — is modeled as a `workspace` object. Its checks run a
single `deno` command at the root, so the toolchain fans out across every member:

```sh
# run all members' checks at once (deno fans out from the root)
dagger check --deno-workspace=packages
dagger check deno/workspaces/test --deno-workspace=packages

# list the members
dagger call deno workspace --path packages members path
```

To work on **one** member, run from inside it — the member is then the only
project selected — or use `project` with the member's path. Its checks run from
the workspace root (so the shared lockfile and sibling `@scope/pkg` imports
resolve) and pass the member's directory as the target — `deno lint ui`,
`deno test ui`, `deno check ui`, `deno fmt --check ui` — so they cover that
member only. Its `container` has the whole workspace mounted with the member as
the workdir, for your own commands:

```sh
cd packages/ui && dagger check                                # just the ui member
dagger call deno project --path packages/ui workspace-root   # -> packages
```

`dagger check` / `dagger generate` handle the mix automatically: each discovered
workspace is checked (with `deno` fanning out) and each standalone project is
checked on its own — members are never run twice. A workspace's `members` is a
plain list rather than a collection for that reason: its members are checked
through the workspace, not one by one.

## Functions

### Checks (`dagger check`)

| Function | Runs |
|---|---|
| `lint` | `deno lint` |
| `test` | `deno test` |
| `type-check` | `deno check` |
| `format-check` | `deno fmt --check` |

Each exists on a project (`project …`) and on a workspace (`workspace …`, running
across every member at once).

`projects` and `workspaces` on the root are collections, which is how
`dagger check` finds them:

| Collection | Keys | Dimension flag | Check addresses |
|---|---|---|---|
| `projects` | standalone project roots | `--deno-project=PATH` | `deno/projects/lint`, `…/test`, `…/type-check`, `…/format-check` |
| `workspaces` | Deno workspace roots | `--deno-workspace=PATH` | `deno/workspaces/lint`, `…/test`, `…/type-check`, `…/format-check` |

The generators are `deno/projects/format` and `deno/workspaces/format`, and
their staleness checks `deno/projects/format/stale` and
`deno/workspaces/format/stale`. `dagger check --help` lists the flags in effect:
`--deno` (`--by-deno`) selects this module, `--deno-projects` /
`--deno-workspaces` a whole dimension.

Each collection's batch runs its check on every selected item in parallel, then
fails naming each item that failed. Its batch `format` returns one changeset
over the selected items.

### Test permissions

`test` runs `deno test --permit-no-files`, plus a permission flag chosen by the
`permissions` setting:

- **`"config"`** (default) runs `deno test -P`, which applies the permission set
  in the project's `deno.json` (`test.permissions`, or a top-level set). The
  same policy then applies locally (`deno test -P`), in CI and here. Deno prints
  `Permissions in the config file is an experimental feature and may change in
  the future.` with every run. A project without a permission set gets **no**
  permissions this way, so its tests that need any fail with `NotCapable`.
- **`"all"`** runs `deno test -A`. Use it when your CI grants permissions on the
  command line (`deno test -A`, `--allow-read …`), as denoland/std and oak do.
  Tests run in a container, so `-A` reaches the container, not your machine.
- **`"none"`** passes no flag, so tests get no permissions at all.

```jsonc
// deno.json — for "config"
{
  "test": {
    "permissions": {
      "net": true,
      "read": ["/data"]
    }
  }
}
```

```sh
dagger settings deno permissions all      # for a repo whose CI runs `deno test -A`
```

Config permission sets landed in Deno **2.5.0**. If you set `version` to an
older release, `"config"` falls back to `-A` for tests, since `-P` doesn't
exist there.

Other `deno test` flags go in `testArgs`. Doc tests (the code blocks in JSDoc
comments and markdown) only run with `--doc`:

```sh
dagger settings deno testArgs '["--doc", "--parallel", "--ignore=_tools/"]'
```

Large suites can need a lot of memory in the Dagger engine: a test killed for
running out of memory only reports `exit code: 137`. denoland/std's `cbor`
tests needed about 12 GiB. Give the engine more memory, or leave the heavy
tests out with `--ignore=…` in `testArgs`.

### Type-check

`type-check` runs `deno check .` from the project root; the config's `exclude`
applies. Add flags with `typeCheckArgs` — for example when tooling scripts
import remote modules:

```sh
dagger settings deno typeCheckArgs '["--allow-import"]'
```

`typeCheckTargets` replaces the `.`, and like every setting it applies to every
project and workspace the module checks. Each target is resolved against *each*
root: a workspace member runs `deno check <member>/mod.ts`, a Deno workspace
`deno check mod.ts` at its root, a standalone project `deno check mod.ts` in
its own directory. So `["mod.ts"]` only works where every project and
workspace has a `mod.ts` — a workspace root without one fails with `TS2307`.

```sh
dagger settings deno typeCheckTargets '["mod.ts", "src/"]'
```

When projects differ, leave `typeCheckTargets` at `.` and shape what gets
checked per project instead: list what to skip in each `deno.json`'s `exclude`,
or pass flags with `typeCheckArgs`.

### Format (`dagger generate`)

`format` returns a **changeset**. `dagger generate` runs it on every selected
project and workspace and summarizes the changed files (`apps/api/main.ts +3
-1`), not the diff itself; it asks before writing. Without a terminal to ask
on (CI, a coding agent), pass `-y` to write the changes or `--no-apply` to only
list them:

```sh
dagger generate -y --deno-project=apps/api          # write them
dagger generate --no-apply --deno-project=apps/api  # just list them
dagger -y call deno project --path apps/api format  # one project, via call
```

A changeset applies from the directory you run in, so from inside a project
(`apps/api/src`) `format` returns only the changes under that directory; the
`stale` check there covers the same part. `format-check` still checks the whole
project.

### Build a standalone binary

`compile` returns the compiled executable as a `File` — export it or feed it into
an image. The build runs in a Linux container, so cross-compile with `--target`
if you need a different platform.

```sh
dagger call deno project --path apps/api \
  compile --entrypoint main.ts export --path ./bin/app

# cross-compile
dagger call deno project --path apps/api \
  compile --entrypoint main.ts --target x86_64-unknown-linux-gnu export --path ./bin/app
```

Like `test`, `compile` takes its permissions from the `permissions` setting: with
`"all"` the binary is built with `-A`, with `"none"` with no permissions. With
the default `"config"`, the baked-in permissions come from `deno.json`: declare
the app's default runtime permissions in a top-level `permissions.default` set
(this is the `deno compile -P` set, distinct from `test.permissions`). Below
Deno 2.5.0, `"config"` builds with no permissions rather than `-A`:

```jsonc
// deno.json
{
  "permissions": {
    "default": { "net": true }
  }
}
```

### Toolchain container

`base` is a ready-to-use container (Deno + cache). `install` adds the Deno CLI to
a container you provide (a glibc base such as debian/ubuntu/distroless-cc; for
musl/alpine use `base`).

```sh
# drop into a shell with deno available
dagger call deno base terminal

# print the configured version
dagger call deno version
```

### Configuration

The settings (see [Quick start](#quick-start)) are also the module's
constructor arguments, so `dagger call` takes them before the function. For
`dagger check`, set them with `dagger settings` instead.

```sh
# pin a specific Deno version
dagger call deno --version 2.9.3 version

# bring your own base image
dagger call deno --base docker.io/denoland/deno:debian project --path apps/api \
  compile --entrypoint main.ts export --path ./bin/app

# grant all permissions and run doc tests (a check: exits 0 even if it fails)
dagger call deno --permissions all --test-args=--doc project --path apps/api test
```

## Extend it in your own module

Install the module as a dependency and call it by name. This is where the real
value is: reuse the toolchain, add your own checks, ship images, and expose the
`@up` service the base module intentionally leaves to you.

`dagger-module.toml`:

```toml
[[dependencies]]
  name = "deno"
  source = "github.com/dagger/deno"
```

`main.dang`:

```dang
type MyApp {
  """
  CI for this app: reuse Deno's checks, add our own.
  """
  ci(ws: Workspace!): Void @check {
    let project = deno(version: "2.9.3", permissions: "all", testArgs: ["--doc"])
      .project(ws, "apps/api")
    run(project.lint(ws))
    run(project.typeCheck(ws))
    run(project.test(ws))

    # Or through the collections: every standalone project, one of them, or
    # some of them. Keys are workspace-root-relative project paths.
    let projects = deno.projects(ws)
    run(projects.batch.test(ws))
    run(projects.get(key: "apps/web").lint(ws))
    run(projects.subset(keys: ["apps/api", "apps/web"]).batch.formatCheck(ws))
    run(deno.workspaces(ws).batch.typeCheck(ws))
    null
  }

  """
  A check called through a dependency comes back as a Check that has not run:
  ask whether it passed.
  """
  let run(check: Check!): Void {
    if (check.pass == false) {
      raise check.error.message ?? "check failed"
    }
    null
  }

  """
  Ship a minimal image from the compiled binary.
  """
  image(ws: Workspace!): Container! {
    let bin = deno.project(ws, "apps/api").compile(ws, entrypoint: "main.ts")
    container
      .from("debian:stable-slim")
      .withFile("/app", bin, permissions: 493)
      .withEntrypoint(["/app"])
  }

  """
  Run this app's dev server with `dagger up`.
  """
  serve(ws: Workspace!): Service! @up {
    deno
      .project(ws, "apps/api")
      .container(ws)
      .withExposedPort(8000)
      .asService(args: ["deno", "serve", "--allow-net", "--port", "8000", "main.ts"])
  }
}
```

The collections' batches (`projects(ws).batch.lint(ws)`, `.test`, `.typeCheck`,
`.formatCheck`, and `.format` returning a `Changeset`) take the same `ws`; so
does each item's function.

## Development

The module is split into `deno.dang` (root `Deno` type and the `DenoProjects` /
`DenoWorkspaces` collections), `deno-project.dang` (`DenoProject`), and
`deno-workspace.dang` (`DenoWorkspace`).

End-to-end tests live in [`.dagger/modules/e2e`](./.dagger/modules/e2e): a Dang
module that installs this module and drives it against the sample projects under
`.dagger/modules/e2e/modules` (a clean project, a badly formatted one, one with a
jsr dependency, and a Deno workspace with two members that import each other).

```sh
# run the e2e checks
dagger check -m .dagger/modules/e2e

# or from the workspace root (also runs them)
dagger check
```
