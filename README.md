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

This module needs a Dagger engine at **`v1.0.0-beta.15`** or later, for
collections. That version is not released yet, so for now run it on a dev
engine build.

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

This adds a `[modules.deno]` entry to your `dagger.toml`. Its settings are the
Deno toolchain:

| Setting | Default | Meaning |
|---|---|---|
| `version` | `2.9.3` | Deno version for the default base image (`denoland/deno:alpine-<version>`). |
| `base` | the image above | Base container for Deno commands; it must have `deno` on `PATH`. |

```sh
dagger settings deno version 2.9.3
```

writes

```toml
[modules.deno.settings]
version = "2.9.3"
```

**2. Run checks and generators.** Projects and workspaces are discovered from
where you stand (see [Discovery](#discovery)):

```sh
dagger check      # lint, test, type-check and format-check every project and workspace
dagger generate   # format: runs `deno fmt`, previews the diff, then writes (add -y to skip the prompt)
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
dagger check --deno --test --deno-project=apps/api --deno-project=apps/web
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

**4. Or call a function directly** — to run one thing on one project. `--path`
may point *inside* a project; it snaps up to the nearest `deno.json` /
`deno.jsonc` (pass `--find-up=false` when it is already a root):

```sh
dagger call deno project --path apps/api lint
dagger call deno project --path apps/api test
dagger call deno project --path apps/api/src type-check
```

> Don't want to install? Run a function one-off with `-m`, dropping the module
> name: `dagger -m github.com/dagger/deno call project --path apps/api lint`.

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
commands still mount the workspace root, so the shared `deno.lock`, import map
and sibling packages resolve; `dagger check` there checks just that member.
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
dagger call deno workspace --path packages lint
dagger call deno workspace --path packages test
dagger call deno workspace --path packages type-check

# list the members
dagger call deno workspace --path packages members path
```

To work on **one** member, use `project` with the member's path — the container
mounts the whole workspace root (so the shared lockfile and sibling `@scope/pkg`
imports resolve) and scopes the command to that member:

```sh
dagger call deno project --path packages/ui test
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

Tests often need permissions. Those come from the **project's `deno.json`**, not
from Dagger flags: `test` always runs `deno test -P`, which applies the config's
permission set. Declare what your tests need in `deno.json`:

```jsonc
// deno.json
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
# no permission flags — deno.json governs them
dagger call deno project --path apps/api test
```

Keeping permissions in `deno.json` means the same policy applies locally
(`deno test -P`), in CI, and here — there's one source of truth. This uses config
permission sets, which landed in Deno **2.5.0**; if you override `version` to an
older release, `test` falls back to `-A` (grant all) since `-P` doesn't exist yet.

### Format (`dagger generate`)

`format` returns a **changeset**. Dagger prints the diff and asks before writing;
add `-y` to apply it. `dagger generate` runs it on every selected project and
workspace.

```sh
# apply it to your working tree
dagger -y call deno project --path apps/api format
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

Like `test`, `compile` takes no permission flags — the binary's baked-in
permissions come from `deno.json`. Declare the app's default runtime permissions
in a top-level `permissions.default` set (this is the `deno compile -P` set,
distinct from `test.permissions`):

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

`version` and `base` are the module's settings (see [Quick start](#quick-start))
and its constructor arguments, so `dagger call` takes them before the function:

```sh
# pin a specific Deno version
dagger call deno --version 2.9.3 project --path apps/api test

# bring your own base image
dagger call deno --base docker.io/denoland/deno:debian project --path apps/api lint
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
    let project = deno(version: "2.9.3").project(ws, "apps/api")
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
