# Deno module for Dagger

A [Dagger](https://dagger.io) module for [Deno](https://deno.com) projects,
written in [Dang](https://docs.dagger.io/next/extending/sdks/dang/).

It does **not** just wrap the `deno` CLI. It models a Deno project as a typed
object graph and maps Deno's toolchain onto Dagger's first-class verbs, so you
get:

- **CI by design** — the very same checks run at your desk and in CI, in one
  pinned, consistent environment. `dagger check` locally is byte-for-byte what CI
  runs, so there is no separate pipeline to maintain and no "works on my machine".
- **Always-current toolchain, no maintenance** — the default tracks the latest
  published Deno release, re-resolved at most once a week and held stable in
  between, so every run in a given week shares one Deno build. Pin an exact
  release by setting `base` when you need byte-for-byte reproducibility.
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
- **Composability** — install Deno into any container, produce standalone
  binaries, and extend it from your own module.

See [`designs/deno-module.md`](./designs/deno-module.md) for the full design.

## Requirements

This module resolves its default toolchain with a Dang **self call**, which needs
a Dagger engine that includes [dagger/dagger#13693](https://github.com/dagger/dagger/pull/13693).
Until a release ships with it, run against `main`:

```sh
dagger --x-release=main <args…>
```

With a matching installed engine you can drop the flag.

## Quick start

**1. Install the module** into your workspace:

```sh
dagger install github.com/dagger/deno
```

This adds a `[modules.deno]` entry to your `dagger.toml`. No configuration is
needed — the toolchain tracks the latest Deno release. To pin an exact release,
set `base` there (or with `dagger settings`), e.g.
`settings.base = "docker.io/denoland/deno:alpine-2.9.3"`.

**2. Run checks and generators** across everything in the workspace — every
standalone `deno.json`/`deno.jsonc` *and* every Deno workspace (a `deno.json`
`workspace` array), discovered automatically:

```sh
dagger check      # deno:lint-all, test-all, type-check-all, format-check-all
dagger generate   # deno:format-all — runs `deno fmt`, previews the diff, then writes (add -y to skip the prompt)
```

These are Dagger's first-class verbs, so the same commands run identically in CI
— there is no separate pipeline to maintain. And because Dagger surfaces every
generator as a check too, `dagger check` *also* fails when your formatting is out
of date.

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
checked on its own — members are never run twice.

## Functions

### Checks (`dagger check`)

| Function | Runs |
|---|---|
| `project … lint` | `deno lint` |
| `project … test` | `deno test` |
| `project … type-check` | `deno check` |
| `project … format-check` | `deno fmt --check` |

The same four checks exist on `workspace …` (running across every member of a
Deno workspace at once). And each has a workspace-wide counterpart on the root —
`lint-all`, `test-all`, `type-check-all`, `format-check-all` — that runs it across
every discovered workspace and standalone project. Those are what `dagger check`
invokes.

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
permission sets, which landed in Deno **2.5.0**. The default toolchain is always
recent enough; only override `base` with a 2.5.0+ image.

### Format (`dagger generate`)

`format` returns a **changeset**. Dagger prints the diff and asks before writing;
add `-y` to apply it.

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

`toolchain` is the ready-to-use container (Deno + our defaults) every verb builds
on. `install` adds the Deno CLI to a container you provide (a glibc base such as
debian/ubuntu/distroless-cc; for musl/alpine use `toolchain`).

```sh
# drop into a shell with deno available
dagger call deno toolchain terminal

# print the Deno release the toolchain runs
dagger call deno version
```

### Configuration

By default the toolchain tracks the latest published `denoland/deno:alpine`,
re-resolved at most once a week. Override `base` (a constructor argument, set
before the function) to pin an exact release or bring your own image:

```sh
# pin an exact Deno release
dagger call deno --base docker.io/denoland/deno:alpine-2.9.3 project --path . test

# bring your own base image (must have deno on PATH, or run it through install)
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
    let project = deno().project(ws, ".")
    project.lint(ws)
    project.typeCheck(ws)
    project.test(ws)
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

The module is split into `deno.dang` (root `Deno` type), `deno-project.dang`
(`DenoProject`), and `deno-workspace.dang` (`DenoWorkspace`).

End-to-end tests live in [`.dagger/modules/e2e`](./.dagger/modules/e2e): a Dang
module that installs this module and drives it against the sample projects under
`.dagger/modules/e2e/modules` (a clean project, a badly formatted one, one with a
jsr dependency, and a Deno workspace with two members that import each other).

```sh
# run the e2e checks
dagger --x-release=main -m .dagger/modules/e2e check

# or from the workspace root (also runs them)
dagger --x-release=main check
```
