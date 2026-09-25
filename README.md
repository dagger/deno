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

**1. Install the module** into your workspace:

```sh
dagger install github.com/dagger/deno
```

This adds a `[modules.deno]` entry to your `dagger.toml`. Configure the toolchain
there (or with `dagger settings`), e.g. `settings.version = "2.9.3"`.

**2. Run checks and generators** across everything at or below where you
stand — every standalone `deno.json`/`deno.jsonc` *and* every Deno workspace (a
`deno.json` `workspace` array), discovered automatically:

```sh
dagger check      # lint, test, type-check and format-check on every project and workspace
dagger generate   # format — runs `deno fmt`, previews the diff, then writes (add -y to skip the prompt)
```

These are Dagger's first-class verbs, so the same commands run identically in CI
— there is no separate pipeline to maintain. And because Dagger surfaces every
generator as a check too, `dagger check` *also* fails when your formatting is out
of date (the `stale` check).

Select what runs by project, workspace, or check name:

```sh
dagger list deno-projects                           # standalone projects, by path
dagger list deno-workspaces                         # Deno workspaces, by root path
dagger check -l --all                               # one line per project/workspace and check

dagger check --deno-project=apps/api                # every check on one project
dagger check --deno --test --deno-project=apps/api --deno-project=apps/web
dagger check deno/projects/lint                     # one check on every project
dagger check deno/workspaces/test --deno-workspace=.
dagger generate --deno-project=apps/api             # format just that project
dagger -W ./apps/api check                          # or scope by directory
```

**3. Or call a specific function** — to run one thing, or to target a single
project. `--path` is the project root (`.` for a single-project repo) and may
point *inside* a project (it snaps up to the nearest `deno.json`/`deno.jsonc`;
pass `--find-up=false` when it is already a root):

```sh
dagger call deno project --path . lint
dagger call deno project --path . test
dagger call deno project --path apps/api type-check
```

> Don't want to install? Run any command one-off with
> `dagger -m github.com/dagger/deno call …` instead of `dagger call deno …`.

## Monorepos (Deno workspaces)

A [Deno workspace](https://docs.deno.com/runtime/fundamentals/workspaces/) — a
root `deno.json` with a `workspace` array of member packages sharing one
`deno.lock` and import map — is modeled as a `workspace` object. Its checks run a
single `deno` command at the root, so the toolchain fans out across every member:

```sh
# run all members' checks at once (deno fans out from the root)
dagger call deno workspace --path . lint
dagger call deno workspace --path . test
dagger call deno workspace --path . type-check

# list the discovered members
dagger call deno workspace --path . members
```

To work on **one** member, use `project` with the member's path — the container
mounts the whole workspace root (so the shared lockfile and sibling `@scope/pkg`
imports resolve) and scopes the command to that member:

```sh
dagger call deno project --path packages/api test
dagger call deno project --path packages/api workspace-root   # -> the workspace root
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

Keys are workspace-root-relative paths, and only cover the project or workspace
you are in and the ones below it: a project found by walking up from a
subdirectory is not a key, so its checks don't run from there. A standalone
project is one that is neither a Deno workspace root nor a member of one.

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
dagger call deno project --path . test
```

Keeping permissions in `deno.json` means the same policy applies locally
(`deno test -P`), in CI, and here — there's one source of truth. This uses config
permission sets, which landed in Deno **2.5.0**; if you override `version` to an
older release, `test` falls back to `-A` (grant all) since `-P` doesn't exist yet.

### Format (`dagger generate`)

`format` returns a **changeset**. Dagger prints the diff and asks before writing;
add `-y` to apply it. `dagger generate` runs it on every selected project and
workspace (`deno/projects/format`, `deno/workspaces/format`).

```sh
# preview the diff
dagger call deno project --path . format
# apply it to your working tree
dagger -y call deno project --path . format
```

### Build a standalone binary

`compile` returns the compiled executable as a `File` — export it or feed it into
an image. The build runs in a Linux container, so cross-compile with `--target`
if you need a different platform.

```sh
dagger call deno project --path . \
  compile --entrypoint main.ts export --path ./bin/app

# cross-compile
dagger call deno project --path . \
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

`version` and `base` are constructor arguments — set them before the function:

```sh
# pin a specific Deno version
dagger call deno --version 2.9.3 project --path . test

# bring your own base image
dagger call deno --base docker.io/denoland/deno:debian project --path . lint
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
  """CI for this app: reuse Deno's checks, add our own."""
  pub ci(ws: Workspace!): Void @check {
    let project = deno(version: "2.9.3").project(ws, ".")
    run(project.lint(ws))
    run(project.typeCheck(ws))
    run(project.test(ws))
    # Or every standalone project at once, or just some of them:
    run(deno.projects(ws).batch.test(ws))
    run(deno.projects(ws).subset(keys: ["apps/api"]).batch.lint(ws))
    null
  }

  """A check called through a dependency returns a Check; run it."""
  let run(check: Check!): Void {
    if (check.pass == false) {
      raise check.error.message ?? "check failed"
    }
    null
  }

  """Ship a minimal image from the compiled binary."""
  pub image(ws: Workspace!): Container! {
    let bin = deno().project(ws, ".").compile(ws, entrypoint: "src/main.ts")
    container.from("debian:stable-slim")
      .withFile("/app", bin, permissions: 493)
      .withEntrypoint(["/app"])
  }

  """Run this app's dev server with `dagger up`."""
  pub serve(ws: Workspace!): Service! @up {
    deno().project(ws, ".").container(ws)
      .withExposedPort(8000)
      .asService(args: ["deno", "serve", "--allow-net", "--port", "8000", "src/main.ts"])
  }
}
```

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
