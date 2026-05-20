# portable-sandbox — manual

The long-form walkthrough. If you just want the elevator pitch and a few
commands, the top-level [README.md](./README.md) is shorter. Come here when
you actually want to set this up against a real project, understand what
happens at every step, or troubleshoot something.

Cheat sheet at the bottom: [Quick reference](#quick-reference).

---

## 1. What this actually does (one paragraph)

When you let an AI agent loose with your normal shell, it can read your
`.env`, your `~/.ssh`, your AWS keys, and anything else on disk. This sandbox
puts the agent in a Docker container that:

- Sees a **copy** of your project, not the original. Anything it edits stays
  in a separate folder until you choose to keep it.
- Has **no `.env`, no secrets** on disk and none in environment variables.
- Can only run privileged commands (like "run the integration tests against
  the real database") by asking a separate container, the **broker**, by
  name. The broker redacts secret values out of any output it returns.
- Can reach the Anthropic API (so Claude works) but cannot reach your
  internal network or any service you didn't explicitly wire in.

Everything is driven by **one YAML file** per project.

---

## 2. What you need before you start

- **Docker Desktop** running (macOS/Windows) or the Docker daemon (Linux).
- **Node 18+** on your laptop — for the launcher scripts only. The sandbox
  itself runs entirely inside containers, so you do **not** need Python,
  uv, or pnpm installed on the host.
- **`rsync`** (used by `make apply`) and **`git`** (used by `make merge`).
  Both ship with macOS and every Linux distribution.
- A copy of this **`portable-sandbox/`** folder on your laptop. The
  walkthrough assumes you'll run `make` from inside it.

You do **not** need to `npm install` anything. The launcher is zero-dep.

---

## 3. First-time setup against a new project

Let's say your project lives at `~/code/myapp`. You want to let Claude work
on it without exposing its secrets.

### Step 3a — Copy the config template into your project

```sh
cd /path/to/portable-sandbox        # this folder
cp sandbox-config.example.yaml ~/code/myapp/sandbox-config.yaml
```

You can put `sandbox-config.yaml` anywhere — inside the project, next to it,
in a separate folder. Most people put it inside the project. It's a small
plain-text file; nothing secret in it.

### Step 3b — Edit four things in the YAML

Open `~/code/myapp/sandbox-config.yaml` and edit:

1. **`target:`** — path to the project. Use `.` if the config sits inside the
   project, or a relative/absolute path. Both of these work:
   ```yaml
   target: .                          # config is inside myapp/
   target: ~/code/myapp               # config is anywhere else
   target: ../myapp                   # config is in a sibling folder
   ```

2. **`hidden:`** — file patterns the agent should **never see**. Defaults
   cover `.env`, `.ssh`, `.aws`, `.git`. Add anything project-specific (e.g.
   `secrets/**`, `*.pem`).

   Patterns are evaluated **in order, last match wins**, gitignore-style. A
   leading `!` re-allows a path matched by an earlier rule, so you can hide
   a whole family of files and still keep one or two visible:

   ```yaml
   hidden:
     - .env*              # hide .env, .env.local, .env.production, ...
     - "!.env.example"    # ...but keep .env.example visible (template)
     - "!.env.sample"     # ...same for .env.sample
     - "*.pem"            # hide every PEM file
     - "!example.pem"     # ...except this one fixture
   ```

   Globs: `*` matches one path segment, `**` matches across slashes
   (`secrets/**` covers `secrets/foo.txt` and `secrets/nested/bar.txt`).

3. **`secrets:`** — the host paths to `.env`-style files the broker (not the
   agent) is allowed to read. Example:
   ```yaml
   secrets:
     - name: app_env
       path: ./.env             # path is relative to this config file
   ```
   The agent never sees these. The broker reads them only when a recipe asks
   for them.

4. **`recipes:`** — named commands the agent is allowed to ask the broker to
   run. Each recipe declares which secret bundles it needs. Example:
   ```yaml
   recipes:
     integration_tests:
       command: [npm, test]
       secrets: [app_env]
   ```
   When the agent runs `safe-test integration_tests`, the broker injects
   `app_env` into the environment, runs `npm test` in a scratch copy, and
   returns the output (with the secret values redacted).

### Step 3c — Optional: dependencies

If your project has `pyproject.toml` / `package.json` / `requirements.txt`,
edit the `install:` and `dep_volumes:` blocks:

```yaml
install:
  - [uv, sync]                 # or [npm, install], or both
dep_volumes:
  - .venv                      # or node_modules, or both
```

This means: at every launch, run `uv sync` once to populate `.venv`. The
`.venv` is stored in a named Docker volume so the second launch is fast.

---

## 4. Step by step — what happens when you launch

Run it from inside the portable-sandbox folder:

```sh
make up CONFIG=~/code/myapp/sandbox-config.yaml         # opens a bash shell
```

`make up` is a thin wrapper around `bin/sandbox-up`. To pass a different
command (claude, codex, a one-liner) call the script directly:

```sh
/path/to/portable-sandbox/bin/sandbox-up \
  --config ~/code/myapp/sandbox-config.yaml \
  claude
```

(If you put the config in your current directory and want a `bash` shell,
this works too: `/path/to/portable-sandbox/bin/sandbox-up`.)

What unfolds, in plain English:

**1. Read the config.** The launcher parses `sandbox-config.yaml`, validates
everything, and prints what it found.

**2. Build a throwaway copy of your project.** Your project is copied into a
tmp folder like `$TMPDIR/portable-sandbox-workspace-&lt;slug&gt;`. Files matching `hidden:`
(your `.env`, `.git`, `.ssh`) are skipped entirely. Files matching `readonly:`
get chmod'd read-only. The **original `~/code/myapp/` is never modified at any
point**.

**3. Build (or reuse) the Docker images.** First time, this takes 1–2 minutes
to fetch the base images and install Claude. After that, Docker caches the
layers — relaunches take seconds.

**4. Create two private Docker networks.**
- `portable-sandbox-broker-net` — internal only, no internet. Connects the
  agent and broker.
- `portable-sandbox-agent-net` — bridge, has internet. The agent uses it to
  reach the Anthropic API.

**5. Start the broker container.** It sits in the background. It has:
- Your real `.env` files mounted **read-only** at `/run/secrets/*.env`.
- A read-only view of your workspace.
- An HTTP server listening on port 8765 inside the broker network.
- **No internet.**

**6. Run the install hook.** If your config has `install:`, the launcher
spins up one short-lived agent container to run each install command (e.g.
`uv sync`). Output streams to your terminal. The `.venv` ends up in the
named volume.

**7. Start the agent container.** This is the one Claude runs in. It has:
- A **writable** view of your workspace at `/workspace`.
- **Read-only overlays** on top for the `readonly:` paths (kernel enforces
  this — even `chmod` can't bypass it).
- Persistent volumes for `.venv` / `node_modules` (so deps persist).
- Persistent volumes for `~/.claude` / `~/.codex` (so you stay logged in
  across sessions).
- Tools at `/sandbox-tools/` on PATH (you can run `safe-test` and `verify`).
- Read-only root filesystem (writes to `/etc` etc. are blocked).
- Connections to both networks (can reach the broker AND the Anthropic API).
- **No `.env`, no secret env vars, no broker secrets.**

**8. Drop you into the agent.** You're now in a shell inside the container.
Claude (or whatever you launched) runs here.

When you exit (Ctrl-D, `exit`, or close the terminal), the agent container is
removed. The broker keeps running until you run `sandbox-down`.

---

## 5. Working inside the agent — what you'll actually do

Once you're in the agent shell, it looks and feels like a normal Linux box.
`ls`, `cat`, `vim`, `git diff`, all work.

### Run the verification checklist (great for training demos)

```sh
verify
```

This runs ten checks and prints PASS/FAIL with the actual output:

| # | Check |
|---|-------|
| 1 | No `.env` files visible in `/workspace` |
| 2 | No secret-like environment variables |
| 3 | `/run/secrets` not visible inside the agent |
| 4 | Broker refuses raw secret reads (`/raw-env`, `/secrets`, `/env`) |
| 5 | Broker responds to legitimate calls (`/health`, `/recipes`) |
| 6 | Root filesystem is read-only (can't write to `/etc`) |
| 7 | Readonly workspace paths reject writes ("Read-only file system") |
| 8 | Agent CAN reach `api.anthropic.com` |
| 9 | Broker process not visible from agent |
| 10 | Manifests writable + deps populated |

You can run any one individually: `verify hidden_env`, `verify readonly_paths`,
`verify deps`, etc.

### Ask the broker to run a privileged command

```sh
safe-test integration_tests
```

That hits the broker, which:
1. Looks up the recipe `integration_tests` in your config.
2. Loads the secrets the recipe asked for.
3. Copies the workspace into a scratch folder inside the broker (so the test
   command can write logs/cache without modifying your workspace).
4. Runs the command with the secrets in `env`.
5. **Redacts every secret value out of stdout/stderr** before returning.
6. Returns exit code + redacted output to you.

You see the test output. You never see the secrets, even if the test echoed
them.

### Use Claude normally

```sh
claude
# or
claude -p "fix the failing test in tests/auth.test.ts"
```

Claude can read all the non-hidden files, edit anything that isn't `readonly:`,
run commands, install packages with `uv add` / `npm install`. It just can't
exfiltrate your secrets — because they aren't there.

### Add a dependency mid-session

```sh
uv add httpx
# or
npm install --save lodash
```

This updates `pyproject.toml` / `package.json` and the lock file in your
workspace. The new package lands in your `.venv` / `node_modules` volume,
which persists. Next launch it's already there.

---

## 6. Where do your changes live?

**The original `~/code/myapp/` is never touched.** Anything the agent (or you)
edits lives in the workspace copy:

```
$TMPDIR/portable-sandbox-workspace-&lt;slug&gt;/    # on your laptop, outside the container
```

Specifically:

| Thing | Where it lives | Persists? |
|---|---|---|
| Source code edits | `$TMPDIR/portable-sandbox-workspace-&lt;slug&gt;/...` | Until you delete the tmp folder or run a new `sandbox-up` |
| New deps (`.venv`, `node_modules`) | Named Docker volume `portable-sandbox-deps-<slug>-<name>` | Yes, across `sandbox-down` |
| Claude login state | Named Docker volume `portable-sandbox-claude` | Yes |
| Codex login state | Named Docker volume `portable-sandbox-codex` | Yes |
| Agent home dir | Named Docker volume `portable-sandbox-home` | Yes |
| Anything else inside the container | Container filesystem | **Wiped when you exit the agent** |

A **new** `sandbox-up` creates a **new** workspace tmp folder. Edits from a
previous session are NOT automatically carried over. That's intentional —
each session starts from a clean copy of your real project.

To find the current workspace path, look at the launcher's startup output:

```
[sandbox-up] workspace: /var/folders/.../portable-sandbox-workspace.nFgzog
```

Or, from inside the agent: it's always `/workspace`. The path that
corresponds to on the host is in the log above.

---

## 7. Saving changes back to your real repo

The workspace is essentially a throwaway branch. The portable-sandbox folder
ships a few `make` targets that do the safe-mirroring and ff-merge dance for
you; reach for those before hand-rolling rsync / git.

### The easy paths (recommended)

```sh
# Preview what would change, then copy it back (deletions included, with a
# >50-file deletion tripwire). Use --no-delete or --force-delete to tune.
make apply-dry
make apply

# If the agent made git commits inside the sandbox, fast-forward them into
# the target's history (the target must be on the same branch the workspace
# was created from, and must not have advanced since).
make merge-dry
make merge
```

`make help` walks through every flag. The applied changes land in the
target repo as ordinary file changes — review with `git status`, then commit
or stash as you would for any edit.

### Manual fallbacks (when you want full control)

#### Option A — Diff and cherry-pick by hand

From outside the container (in another terminal):

```sh
diff -ruN ~/code/myapp $TMPDIR/portable-sandbox-workspace-&lt;slug&gt; | less
cp $TMPDIR/portable-sandbox-workspace-&lt;slug&gt;/src/foo.py ~/code/myapp/src/foo.py
```

#### Option B — git-style: turn the workspace into a branch

```sh
cd ~/code/myapp
git checkout -b sandbox-session
rsync -av --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.venv' \
  $TMPDIR/portable-sandbox-workspace-&lt;slug&gt;/ \
  ./
git status
git add -p           # stage interactively, review each hunk
git commit -m "from sandbox session"
```

You now have a normal git branch with the agent's changes. Review, push,
PR, merge as normal.

### About installed dependencies

If the agent ran `uv add httpx`, you'll want both:
- The updated **`pyproject.toml`** and **`uv.lock`** copied back to your repo
  (this happens automatically with `make apply`).
- A real `uv sync` on the host repo to install `httpx` into your normal venv.

Without that second step, your IDE / colleagues won't see the new package.

---

## 8. Discarding changes

### Discard the agent's edits (most common case)

The easy path:

```sh
make down            # stop containers
make discard         # dry-run: shows what would be removed
make discard-yes     # actually remove the workspace
```

`sandbox-discard` knows about the readonly `chmod 0555` tier and relaxes
perms before deleting, so you don't need `sudo`.

If you want to nuke them by hand:

```sh
make down
rm -rf $TMPDIR/portable-sandbox-workspace-&lt;slug&gt;
```

If you forget the path, this finds and removes them all:

```sh
sudo find /tmp /var/folders -maxdepth 3 -name 'portable-sandbox-workspace-*' -exec rm -rf {} +
```

(Need `sudo` here because the readonly chmod tier blocks normal `rm` —
`make discard` avoids this by `chmod -R u+w`-ing the tree first.)

### Discard the cached dependencies (forces a fresh install)

```sh
docker volume ls --format '{{.Name}}' | grep ^portable-sandbox-deps- | xargs docker volume rm
```

Next launch re-runs `uv sync` from scratch.

### Discard Claude login state (forces re-login next session)

```sh
docker volume rm portable-sandbox-claude portable-sandbox-codex portable-sandbox-home
```

### Nuke everything sandbox-related

```sh
make down
docker volume ls --format '{{.Name}}' | grep ^portable-sandbox | xargs docker volume rm
docker image  ls --format '{{.Repository}}:{{.Tag}}' | grep portable-sandbox | xargs docker image rm
sudo find /tmp /var/folders -maxdepth 3 -name 'portable-sandbox-workspace-*' -exec rm -rf {} +
```

---

## 9. How testing is affected — the recipe system

This is the part that confuses people most often, so worth a long-ish explanation.

### The problem

Your tests probably need real secrets — a database URL, an API key, a Stripe
test token. If the agent could just `npm test`, it could read those secrets
right out of the env. Then it knows them. Then they could end up in the
chat transcript, your screen recording, Anthropic's logs, etc.

### The solution: name the test commands you trust, run them through the broker

In your `sandbox-config.yaml` you list **recipes**:

```yaml
recipes:
  integration_tests:
    command: [npm, test]
    secrets: [app_env]
  db_migrate_dry_run:
    command: [npx, prisma, migrate, diff]
    secrets: [app_env]
  stripe_health:
    command: [node, scripts/stripe-ping.js]
    secrets: [stripe_test]
```

The agent never invokes these directly. Instead it runs:

```sh
safe-test integration_tests
```

What the broker does:
1. **Verifies** the recipe name exists in the config (rejects unknown names).
2. **Looks up** which secret bundles the recipe declared.
3. **Copies** the workspace to a scratch directory.
4. **Runs** the command there with **only** the named secrets in the
   environment.
5. **Redacts** any secret values that appear in stdout/stderr (so even
   `echo $DATABASE_URL` returns `[REDACTED]`).
6. **Returns** stdout / stderr / exit code to the agent.

The agent sees the test output but not the secrets.

### What tests can and can't do

- Tests **can** read files in the workspace (anything not in `hidden:`).
- Tests **can** read the secrets the recipe asked for, via `process.env.*`.
- Tests **can** make outbound network calls (the broker has internet?
  actually no — the broker is on the internal network with no internet).
  → If your tests need to hit real external APIs, you have two options:
  switch the broker to the bridge network (loosens the model), or run
  external dependencies as containers on the broker's network.

### When a test fails

The exit code propagates back. `safe-test integration_tests` exits with the
test's exit code. The redacted stdout/stderr show you what went wrong.

### When the agent tries something not on the recipe list

`safe-test rm -rf /` is rejected at the client level (the name doesn't match
the safe pattern). Even sending a hand-crafted HTTP POST to `/run` with
`{"recipe": "rm -rf /"}` is rejected — the broker only accepts names matching
`^[a-z][a-z0-9_-]*$` and only runs recipes the config lists.

### Tests-as-positive-control: how you know secrets really work

A subtle benefit: if `safe-test integration_tests` passes with real secrets
injected by the broker, you've proven the secrets are valid without the agent
ever seeing them. The agent can confirm wiring is correct ("the Stripe key
works") without learning the key itself. This is the answer to "how do we
test secrets if the agent can't read them?"

---

## 10. Tearing down

```sh
make down           # or: /path/to/portable-sandbox/bin/sandbox-down
```

This stops the broker and the services container, removes any leftover agent
containers, and removes the two private networks. It does **not** delete:
- Named volumes (deps, claude login, codex login, services logs)
- Workspace tmp folders

That's deliberate — usually you want those to persist across sessions so the
next `make up` is fast and your agent edits survive. See
[Section 8](#8-discarding-changes) for cleanup commands when you do want to
wipe them.

---

## 11. Common follow-ups

### "I changed the Dockerfile, how do I rebuild?"

```sh
docker image rm portable-sandbox-agent:local portable-sandbox-broker:local
make up CONFIG=...      # next launch builds fresh
```

### "I want to use a different agent (Codex, plain bash)"

The Makefile target always opens a `bash` shell. To pick something else,
call `bin/sandbox-up` directly:

```sh
bin/sandbox-up --config ... bash         # default
bin/sandbox-up --config ... codex
bin/sandbox-up --config ... claude
bin/sandbox-up --config ... sh -c "uv run python -m mymodule"
```

### "I have several projects — how do I keep them separate?"

Each project has its own `sandbox-config.yaml`. The launcher derives a
**target slug** from the project path, so volumes for different projects
don't collide:

```
portable-sandbox-deps-<slug-for-myapp>-venv
portable-sandbox-deps-<slug-for-other>-venv
```

### "How do I see what containers are running right now?"

```sh
docker ps --filter name=portable-sandbox
```

### "How do I look inside the broker (without restarting)?"

```sh
docker exec -it portable-sandbox-broker sh
```

But the broker image is intentionally minimal — no real shell tooling. If
you need to debug, edit `images/broker.Dockerfile` to add what you need,
then rebuild.

### "Can I use this against a remote / shared repo?"

Yes, but the **workspace is local**. The launcher copies from `target:`,
which is a local path. If your repo is on a Git server, clone it first:

```sh
git clone git@github.com:org/repo ~/code/repo
# write sandbox-config.yaml pointing at ~/code/repo
bin/sandbox-up --config ~/code/repo/sandbox-config.yaml claude
```

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker is not available` | Docker Desktop not running | Start it. |
| `config not found` | No `sandbox-config.yaml` in cwd or `--config` | Pass `--config /full/path/to/sandbox-config.yaml`. |
| `target repo not found` | `target:` path wrong or unreadable | `ls` the path on your host. Use absolute path if confused. |
| `secret file not found` | `path:` under `secrets:` is wrong | Check the path. It's resolved relative to the YAML file. |
| Install hook fails | `uv sync` couldn't read the lockfile (corrupt or version mismatch) | Run the same command on the host to see the real error. Usually deleting `uv.lock` and rerunning fixes it. |
| `safe-test foo` returns "unknown recipe" | Recipe name doesn't match config | `cat sandbox-config.yaml` and check names. |
| Tests can't reach a database | Broker is on the internal network — no DNS to your prod | Bring the DB up as a container on the broker network, or rethink whether this test belongs in the sandbox. |
| Claude says "please log in" every session | `portable-sandbox-claude` volume got removed | `docker volume ls | grep claude` — recreate or just log in once more. |
| `verify readonly_paths` shows `Permission denied` instead of `Read-only file system` | The chmod tier blocked it but the bind-mount overlay didn't apply | Check `readonly:` patterns in your config match real paths. |
| Slow first launch | Building images + first `uv sync` | Expected. Subsequent launches are fast (Docker layer cache + dep volume). |

---

## Quick reference

```sh
# Launch (from the portable-sandbox folder)
make up                                 # config in cwd, bash shell
make up CONFIG=~/code/myapp/sandbox-config.yaml
bin/sandbox-up --config ... claude      # custom command

# Inside the agent
verify                                  # full PASS/FAIL checklist
verify deps                             # just one check
safe-test integration_tests             # privileged action via the broker
safe-service start backend              # long-running dev process
uv add httpx                            # adds a dep, lands in writable manifest
exit                                    # leaves the agent (broker keeps running)

# Bring changes back to the target repo
make diff                               # see what changed
make apply-dry                          # preview the copy-back
make apply                              # actually copy (with deletion safety)
make merge-dry                          # preview commit fast-forward
make merge                              # ff-merge sandbox commits into target

# Outside the container — cleanup
make down                               # stop broker + services, remove networks
make discard-yes                        # wipe the workspace copy
docker volume rm $(docker volume ls -q | grep ^portable-sandbox)   # all volumes
docker image  rm portable-sandbox-agent:local portable-sandbox-broker:local
```

That's the whole thing. The mental model is three boxes: **Vault** (broker)
holds secrets, **Helper** (services) runs your dev stack, **Workshop**
(agent) is where the AI works. Everything else is config.
