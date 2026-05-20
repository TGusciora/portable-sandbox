# CONFIG is the path to a sandbox-config.yaml. Resolved relative to the
# directory you run `make` from (cwd), NOT to this Makefile. Paths *inside*
# the YAML (target, secrets, mounts, compose.file) are resolved relative to
# the YAML's own directory — moving the config file changes their meaning.
# Override per invocation: `make up CONFIG=~/code/myapp/sandbox-config.yaml`.
#
# This Makefile sits at the root of the portable-sandbox repo, alongside
# bin/ and sandbox-config.example.yaml. Run `make` from this directory.
CONFIG ?= ./sandbox-config.example.yaml
BIN    := ./bin

.PHONY: up down discard discard-yes apply apply-dry apply-additive apply-force diff merge merge-dry restart reset help

up:
	node $(BIN)/sandbox-up --config $(CONFIG)

down:
	node $(BIN)/sandbox-down --config $(CONFIG)

discard:
	node $(BIN)/sandbox-discard --config $(CONFIG)

discard-yes:
	node $(BIN)/sandbox-discard --config $(CONFIG) --yes

# Copy the agent's changes from the workspace back into your real target repo,
# INCLUDING deletes (so files the agent removed go away too). Three safety
# layers stop accidents:
#   1. Files matching `hidden:` or `readonly:` are excluded from rsync entirely,
#      so they can never become delete candidates.
#   2. The same patterns are repeated as rsync `--filter='P ...'` (protect)
#      rules, so even a stale config can't blow them away.
#   3. A tripwire counts how many files would be deleted. If it exceeds 50
#      the apply aborts — a config typo can easily broaden a `hidden:` glob
#      and silently nuke a directory. Use `apply-force` after `apply-dry`
#      review when the large delete is intentional.
apply:
	node $(BIN)/sandbox-apply --config $(CONFIG)

# Preview only: print what `apply` would change without writing anything.
# Comparison is by file content hash, not timestamp, so mtime drift between
# the workspace copy and the target never produces a phantom "change".
apply-dry:
	node $(BIN)/sandbox-apply --config $(CONFIG) --dry-run

# Copy-only: never remove a file from the target, even if the agent deleted
# it in the workspace. Use when you want to merge new/edited files without
# committing to any deletions.
apply-additive:
	node $(BIN)/sandbox-apply --config $(CONFIG) --no-delete

# Bypass the >50-file deletion tripwire. Run `make apply-dry` first and read
# the output — only use this once you've confirmed the deletions are wanted.
apply-force:
	node $(BIN)/sandbox-apply --config $(CONFIG) --force-delete

diff:
	node $(BIN)/sandbox-diff --config $(CONFIG)

# Move git commits the agent made in the workspace into your real target
# repo. Done as `git fetch` from the workspace into the target, then a
# fast-forward — so it refuses if the target's branch has moved on since the
# workspace was created (avoiding any merge-conflict surprise). Push from the
# target afterwards.
merge:
	node $(BIN)/sandbox-merge --config $(CONFIG)

merge-dry:
	node $(BIN)/sandbox-merge --config $(CONFIG) --dry-run

restart: down up

# Throw away the cached workspace copy and re-copy from the target. Run this
# whenever you've edited source files in the target outside the sandbox —
# plain `make down && make up` reuses the existing workspace, so those edits
# wouldn't show up inside the agent shell.
reset: down discard-yes up

help:
	@echo "Tip: override the config file per command, e.g."
	@echo "     make up CONFIG=~/code/myapp/sandbox-config.yaml"
	@echo ""
	@echo "Lifecycle: up | down | restart | reset | discard | discard-yes"
	@echo "  up            = build images, start broker/services, open agent shell"
	@echo "  down          = stop the broker and services containers; workspace copy"
	@echo "                  is kept on disk so you can inspect/apply/discard it"
	@echo "  restart       = down + up (reuses workspace, keeps any agent edits)"
	@echo "  discard       = wipe the workspace copy (asks for confirmation first)"
	@echo "  discard-yes   = same as discard but skip the confirmation prompt"
	@echo "  reset         = down + discard-yes + up — wipe the workspace and start"
	@echo "                  fresh from the current target repo (use after editing"
	@echo "                  source files in the target outside the sandbox)"
	@echo ""
	@echo "Bring back changes the agent made (workspace -> target):"
	@echo "  apply         = copy edits AND deletions back. Safety: aborts if it"
	@echo "                  would remove more than 50 files unless --force-delete."
	@echo "  apply-dry     = preview the same operation; writes nothing. Compares"
	@echo "                  by file content, so unchanged files never show up."
	@echo "  apply-additive= copy edits but never delete anything from the target"
	@echo "  apply-force   = bypass the 50-file deletion tripwire (review apply-dry"
	@echo "                  first; intended for legitimate large refactors)"
	@echo ""
	@echo "Inspect:  diff"
	@echo "  diff          = show what the workspace contains relative to the target"
	@echo ""
	@echo "Git:      merge | merge-dry"
	@echo "  merge         = fast-forward commits made inside the sandbox into the"
	@echo "                  target's git history. Refuses if the target branch has"
	@echo "                  moved on (diverged). Push from the target after."
	@echo "  merge-dry     = preview which commits would be merged"
