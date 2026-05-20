# portable-sandbox

A safer way to let an AI coding agent — Claude Code, Codex, or any shell —
work on your project. The agent runs inside a Docker sandbox that sees only
a **copy** of your code, with no `.env` files, no secret env vars, no SSH
keys, no AWS / kube / gcloud credentials. Tests and commands that genuinely
need real secrets still work; they go through a separate **broker** container
that only runs commands you've pre-approved by name.

## Why you'd want this

When you give an agent a normal shell, it can read everything you can read:
every `.env`, every `~/.ssh` key, every credential in `~/.aws` and `~/.kube`,
your shell history, every file under `$HOME`. If it leaks a token — pastes
it into chat, exfiltrates it via a tool call, gets prompt-injected from a
fetched webpage — the blast radius is your whole laptop.

This project caps that blast radius. The agent sees a writable scratch copy
of your repo plus the tools you decided to give it. Nothing else.

## Requirements

- **Docker** — Docker Desktop on macOS/Windows, the daemon on Linux.
- **Node 18 or newer** on the host. The launcher scripts use it. The
  sandbox itself runs entirely inside containers; you do **not** need
  Python, uv, or pnpm installed on the host.
- **A target repo on local disk.** The launcher copies from a path; if your
  project lives on a Git server, `git clone` it somewhere first.
- **`rsync`** (used by `sandbox-apply`) and **`git`** (used by
  `sandbox-merge`). Both ship with macOS and every Linux distribution.

No `npm install` step. The launcher is zero-dep.

## Quickstart

```sh
# From inside this repo:

# 1. Copy the example config next to (or inside) your target project.
cp sandbox-config.example.yaml ~/code/myapp/sandbox-config.yaml
${EDITOR:-vi} ~/code/myapp/sandbox-config.yaml   # set target, secrets, recipes

# 2. Launch a Claude shell against it.
make up CONFIG=~/code/myapp/sandbox-config.yaml

# 3. Inside the agent shell — confirm the sandbox is doing what we promised.
verify

# 4. Run a privileged command (e.g. integration tests with real secrets).
safe-test integration

# 5. Exit (Ctrl-D), then stop everything.
make down
```

`make help` lists every target with a plain-English explanation.

## Mental model

Three containers, two private Docker networks:

| Container | What runs there | Internet | Real secrets | Docker access |
|-----------|-----------------|----------|--------------|---------------|
| **Broker**   | a tiny HTTP server that only knows how to run the recipes you declared | no  | yes — mounted read-only as `/run/secrets/<name>.env` | no |
| **Services** | long-running dev processes (uvicorn --reload, pnpm dev, schedulers, …) | yes | yes — injected into each child process's env | no |
| **Agent**    | the AI shell — Claude / Codex / bash — and a copy of your repo at `/workspace` | yes (so the API call works) | **no** — no `.env` on disk, no secrets in env vars | no |

In plain English:
- **Broker** is a locked vault. It opens only for pre-approved actions, and
  it redacts secret values out of any output before returning to the agent.
- **Services** is the trusted helper that runs your dev stack. The agent
  starts and stops services by name; it cannot exec inside.
- **Agent** is a throwaway desk. If it gets compromised, there's nothing
  sensitive there to steal.

Everything is configured by a single `sandbox-config.yaml` per project. See
[`sandbox-config.example.yaml`](./sandbox-config.example.yaml) — it's heavily
commented and shows every field.

## What lives where in this repo

| Path | Purpose |
|------|---------|
| `Makefile`                    | top-level commands: `make up / down / diff / apply / merge / discard`. Run `make help` for the full list. |
| `sandbox-config.example.yaml` | annotated template — copy this and edit it for your project |
| `bin/`                        | launcher scripts the Makefile invokes |
| `lib/`                        | shared helpers (config loader, workspace prep, CLI parser, logger) |
| `tools/`                      | tools made available **inside the agent shell** (`verify`, `safe-test`, `safe-service`) |
| `images/`                     | Dockerfiles for the agent and broker containers |
| `broker/`                     | the broker's HTTP server |
| `services/`                   | the services container's control plane |
| `README_MANUAL.md`            | full walkthrough — config tour, what happens at launch, where your edits live, how to keep changes, troubleshooting |

## Verifying it works (and a good demo)

From inside the agent shell:

```sh
verify
```

Runs a PASS/FAIL checklist: no `.env` visible in the workspace, no
secret-shaped env vars, broker refuses raw secret reads, root filesystem is
read-only, `readonly:` paths can't be written even by `chmod`, broker
recipes work, internet to the Anthropic API is reachable. Each check prints
its actual observed output, so you can show it to a sceptical colleague.

## Saving changes back to your real repo

The original project on your laptop is **never modified**. The agent edits
land in a workspace copy. To bring them back:

```sh
make diff                       # see what changed
make apply-dry                  # preview the file copy back
make apply                      # actually copy (with deletion safety)
# or, if the agent made git commits:
make merge-dry
make merge                      # fast-forward target's git history
```

See `make help` and `README_MANUAL.md` for the full story (additive mode,
deletion tripwire bypass, per-file cherry-picks, dependency persistence).

## Platform notes

- **macOS** — Docker Desktop runs in a Linux VM, so bind-mount I/O is
  slower than on native Linux. `sandbox-discard` uses POSIX `chmod -R u+w`
  to undo the readonly tier.
- **Linux** — uses the host Docker daemon directly. If a heavy build (e.g.
  `pnpm install`) hits `ENOSPC: System limit for number of file watchers
  reached`, raise `fs.inotify.max_user_watches` — Docker doesn't isolate
  inotify pools from the host.
- **Windows** — not tested. Everything is Node + Docker, so WSL2 should
  work; path-resolution quirks haven't been ironed out.
- **`.DS_Store`** — macOS Finder noise. The launcher filters these out of
  the workspace and `sandbox-apply` refuses to round-trip them back.

## More

[`README_MANUAL.md`](./README_MANUAL.md) is the long-form walkthrough: how to
edit the config from scratch, step-by-step what happens when you launch,
where your edits live, how to keep / discard / cherry-pick changes, the
recipe system in detail, and a troubleshooting table.
